/**
 * F20261026emct：embedBatch 分片闸门（纯函数，可单测）。
 *
 * ── 治本纪律不变量（第 7 次修复与前 6 次的分水岭）────────────────────────
 * write lane 任意时刻在飞 embedding 文本总量 ≤ 硬上界（token 预算）。
 *
 * 前 6 轮修复（F20261013ebps 背压 / F20261016ebrt 双 lane / F20261015kill
 * 进程隔离 / F20261020slvg 诚实准入+看门狗 / F20260821evaf 版本锚 / worker
 * 串行化）逐条堵具体路径：背压管 in-flight「请求数」不管单批「文本量」；
 * waitSlot 管速率管不住单批体量；超时预算 120s 封顶但 timeout≠cancel——
 * 2026-10-23 雪崩实证：49 条巨批（单条 6k chars 截断后仍巨）独占唯一槽位
 * （MAX_IN_FLIGHT=1），worker 实际算远超 120s，每轮白烧 CPU，98+ 次超时
 * 重试滚出上千垃圾任务。缺的从来不是又一层重试，而是一条全局不变量：
 * 任何调用方都无法把超过预算的文本量送进 write lane。
 *
 * 闸门位置：EmbeddingServiceImpl.embedBatch 入口（所有生产者共用的唯一
 * 收口点）——调用方（store-memory 的 fireAndForgetEmbedBatch、retry worker、
 * 回填）无需各自分片，新生产者自动受控。
 *
 * 估算口径：粗算 tokens——CJK ~1 char/token，其余 ~4 chars/token（见 estimateTokens
 * 注释，与 store-memory EMBED_MAX_CHARS 的 token 模型对齐）。不引 tokenizer：精确分词
 * 对「体量上界」无增量价值，且 tokenizer 本身有加载与性能成本。
 */

/** 单批 token 预算默认值：8192 tokens ≈ 16 条 512-token chunk（bge-m3 单条
 *  经验值）。与 worker 端无耦合——这是在飞文本量的上界，不是模型窗口。 */
export const DEFAULT_BATCH_TOKEN_BUDGET = 8192;

/** chars → tokens 粗估（CJK 敏感，F20261026emct delta 复审修正）：
 *  CJK（含全角/假名/注音/CJK 标点）~1 char/token，其余（拉丁/数字/ASCII）~4 chars/token。
 *  口径对齐 store-memory.ts EMBED_MAX_CHARS=6000 注释的 token 模型（6000 chars ≈ 8192 tokens 的 75%，
 *  即中文场景 ~1 char/token）——首版 chars/2 对中文低估约 2×（拆晚侧，危险方向），已修。
 *  仍是估算非精确 tokenizer：预算闸门宁早拆不晚拆，精确化无增量价值。 */
const CJK_CHAR_RE = /[\u3000-\u9fff\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_CHAR_RE) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

/**
 * F20261026emct delta 处置（严重发现 1）：为分片子批包装调用方 opts。
 *
 * 分片×salvage 契约错位：调用方 salvage 闭包假定 embeddings 与整批 items 对齐，
 * 但子批晚到结果只携带该子批的向量——offset>0 的子批超时晚到时，若原样透传，
 * 调用方会把别批的向量存到 items[0..] 错误 entry（静默 vec 污染 + markTaskDone
 * 错误去重）。修复：契约改为 salvage(embeddings, startIndex)——子批向量在整批中
 * 的起始下标显式传递（embedding-gateway.ts EmbedBatchCallOptions），本函数负责
 * 在 service 层按子批 offset 注入，非分批路径 startIndex 保持 undefined（=0 语义）。
 *
 * 独立导出（非类私有）：可单测，不依赖真 worker 超时模拟。 */
export function wrapOptsForShard<T extends { salvage?: (embeddings: Float32Array[], startIndex?: number) => void }>(
  opts: T | undefined,
  offset: number,
): T | undefined {
  if (!opts?.salvage) return opts;
  const original = opts.salvage;
  return { ...opts, salvage: (embeddings: Float32Array[]) => original(embeddings, offset) };
}

/** 解析 OTTER_EMBED_BATCH_TOKEN_BUDGET 环境变量。
 *  - 未设 / 非法 / <1：返回默认值（非法时 warn 一条，不静默——对齐
 *    resolveIntraOpThreads 的防钳制失效不可见纪律）。
 *  - 环境变量逃生口而非配置 schema：与 OTTER_EMBED_INTRA_OP_THREADS 同模式
 *    （紧急调参用，不进 config；检视 #1107 先例）。 */
export function resolveBatchTokenBudget(
  env: string | undefined = process.env.OTTER_EMBED_BATCH_TOKEN_BUDGET,
  fallback: number = DEFAULT_BATCH_TOKEN_BUDGET,
): number {
  if (env === undefined || env === "") return fallback;
  const n = Number.parseInt(env, 10);
  if (!Number.isFinite(n) || n < 1) {
    // eslint-disable-next-line no-console -- 可能被无 logger 的调用方使用
    console.warn(`[embedding] OTTER_EMBED_BATCH_TOKEN_BUDGET="${env}" 非法，回落默认 ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * 按预算把整批 texts 拆成子批。
 *
 * 不变量：
 * - 输出子批拼接（保序）与输入完全一致——闸门只改变「怎么送」不改变「送什么」；
 * - 每个子批的 token 估算之和 ≤ budget，除两类豁免：
 *   a) 单条文本自身超预算——单独成批放行（拆文本会破坏语义完整性；这类
 *      文本进 lane 后由既有的单条超时/看门狗路径兜底，且 store-memory 端
 *      6k chars 截断已先行限长）；
 *   b) budget < 1（resolve 已拦，防御）。
 * - 空输入返回 []（embedBatch 对空数组直接短路）。
 */
export function splitBatchByTokenBudget(
  texts: string[],
  budget: number,
): string[][] {
  if (texts.length === 0) return [];
  if (budget < 1) return [texts];

  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const text of texts) {
    const t = estimateTokens(text);
    if (current.length > 0 && currentTokens + t > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += t;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
