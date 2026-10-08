/**
 * F20261008mrrk Phase 0：golden 评测语料与查询集（合成种子集，待真实使用数据校准）。
 *
 * 构成原则：
 * - 确定性：内容固定；时间戳用 daysAgo(N) 相对构造（动态日期模式，参考 #1126——
 *   禁写死 ISO 日期防日期炸弹，lint:date-bombs 在 CI）。相对年龄恒定 →
 *   time_decay 输入恒定 → 指标跨日复跑稳定。
 * - 覆盖面：contentType 覆盖 message/fact/feature/feature_chunk/research/research_chunk；
 *   layer 覆盖 working/historical/document；conversationId 覆盖 3 个对话 + 跨对话(null)；
 *   年龄分布 1~365 天；含 user_flagged 与 retrieval_count 预设（frequency 信号）。
 * - 相关性分级：3=核心答案 / 2=强相关 / 1=弱相关 / 0=不相关（未标注默认）。
 *
 * ⚠️ 合成种子集声明：条目与标注为人工构造，不是真实使用数据；真实数据校准
 * 需搭档抽查（特性文档 R2）。基线数字锁定的是当前管线在此种子集上的行为。
 */
import type { MemoryEntry } from "@entities/memory/memory-entry";

/** 当前对话替身（Layer D 查询传 currentConversationId 用） */
export const CONV_ALPHA = "golden-conv-alpha";
export const CONV_BETA = "golden-conv-beta";
export const CONV_GAMMA = "golden-conv-gamma";

/** 相对时间构造：N 天前（动态日期模式，评测运行时求值 → 年龄恒定） */
export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function entry(
  id: string,
  layer: MemoryEntry["layer"],
  contentType: MemoryEntry["contentType"],
  ageDays: number,
  content: string,
  conversationId: string | null,
): MemoryEntry {
  return {
    id,
    layer,
    contentType,
    sourceId: id,
    sourceTable: "golden_fixture",
    conversationId,
    granularity: "coarse",
    content,
    metadata: { corpus: "golden-seed-v2" },
    createdAt: daysAgoIso(ageDays),
  };
}

/** 权重预设（检索副作用重置后重放）：user_flagged 与 retrieval_count */
export interface WeightPreset {
  entryId: string;
  userFlagged?: boolean;
  retrievalCount?: number;
}

/** ── 语料条目（37 条）────────────────────────────────────────── */

export const CORPUS: MemoryEntry[] = [
  // 事实层（fact，10 条）
  entry("g-fact-01", "working", "fact", 3,
    "worktree 隔离红线：主目录只读，一切 git 追踪文件的修改必须在 worktree 分支内提交，禁止直接 push 受保护分支",
    null),
  entry("g-fact-02", "historical", "fact", 30,
    "commit 规范：提交信息必须带 [FID][模块][类型] 前缀，author 使用海獭署名，先读 .githooks/commit-msg 再提交",
    null),
  entry("g-fact-03", "working", "fact", 1,
    "sqlite-vec 扩展不可用时 memory_vec 虚拟表不创建，检索降级为纯 FTS5（D22 降级模式），bootstrap 只告警不中断",
    null),
  entry("g-fact-04", "historical", "fact", 90,
    "jieba 分词表 memory_fts_jieba 用于中文短查询，旧 trigram 表 memory_fts 只写不查已退役",
    null),
  entry("g-fact-05", "historical", "fact", 180,
    "RRF 融合参数：rrfK=60，alpha=0.4 偏信任 FTS，bothBoost=1.2 加成两路同时命中的条目",
    null),
  entry("g-fact-06", "working", "fact", 7,
    "rerank 五信号乘法堆叠：rrf × time_decay × frequency × user_flag × conversation_boost，无量纲归一化",
    null),
  entry("g-fact-07", "historical", "fact", 14,
    "nDCG 位置折扣公式 log2(rank+1)，MRR 取首个相关条目排名倒数，评测口径见 F20261008mrrk",
    null),
  entry("g-fact-08", "historical", "fact", 60,
    "embedding bge-m3 向量维度 1024，modelRev 恒为 unknown，本地模型整目录替换时版本锚检测不到（F20260821evaf）",
    null),
  entry("g-fact-09", "working", "fact", 2,
    "golden 查询集是合成种子集，待真实使用数据校准，搭档需抽查标注质量",
    null),
  entry("g-fact-10", "historical", "fact", 365,
    "记忆层三分类 working/historical/document，document 层不做状态转换，生命周期由 status 字段管理",
    null),

  // 对话消息层（message，11 条，3 个对话）
  entry("g-msg-01", "historical", "message", 45,
    "搭档拍板：检索排序优化先做评测基线，Phase 1 信号归一化融合延后——基线数据先行（F20261008mrrk）",
    CONV_BETA),
  entry("g-msg-02", "historical", "message", 46,
    "审视结论：文档轮 0 严重 3 建议已处置，锚点精确化与 summary 长度收口",
    CONV_BETA),
  entry("g-msg-03", "historical", "message", 120,
    "#944 事故复盘：特性文档写 vec 键替换已验证，实际测试库根本没有 memory_vec 表——测试库必须加载 sqlite-vec",
    CONV_GAMMA),
  entry("g-msg-04", "historical", "message", 121,
    "#1173 日期炸弹重生：收窄版 lint 只报 ISO 日期与真实时钟共现的高危组合，纯 fixture 不报",
    CONV_GAMMA),
  entry("g-msg-05", "historical", "message", 50,
    "F20260826rcmp 埋点：record-search-query 落库检索中间分值，debug 通道供评测消费",
    CONV_BETA),
  entry("g-msg-06", "historical", "message", 150,
    "#1126 动态日期模式：测试用 daysAgo 相对时间构造 fixture，禁止写死日期防日期炸弹",
    CONV_GAMMA),
  entry("g-msg-07", "working", "message", 5,
    "本对话：给 PR #1133 补 Phase 0 评测实现，指标模块 nDCG 与 MRR 公式单测锁定",
    CONV_ALPHA),
  entry("g-msg-08", "working", "message", 4,
    "本对话：评测 runner 复用 tests/usecases/memory 基建，跑 FTS+RRF+rerank 全链路",
    CONV_ALPHA),
  entry("g-msg-09", "working", "message", 2,
    "本对话：golden 语料固定相对时间戳，覆盖 contentType 与时间分布",
    CONV_ALPHA),
  entry("g-msg-10", "working", "message", 1,
    "本对话：基线数字锁定回归地板，指标不许变差，进 CI 全量测试复跑",
    CONV_ALPHA),
  entry("g-msg-11", "working", "message", 6,
    "其他对话：也在讨论排序指标，但不是本对话的上下文（跨对话干扰项）",
    CONV_BETA),

  // 文档层（feature/feature_chunk/research/research_chunk，16 条）
  entry("g-feat-01", "document", "feature", 40,
    "F20260902rcp1 混合检索架构设计：FTS5 BM25 与 Vec 双路召回、每 source top-3 预聚合、加权 RRF 融合、rerank 五信号堆叠",
    null),
  entry("g-feat-01-c1", "document", "feature_chunk", 40,
    "F20260902rcp1 chunk：双路召回与预聚合细节，source 维度配额与聚合键",
    null),
  entry("g-feat-01-c2", "document", "feature_chunk", 40,
    "F20260902rcp1 chunk：RRF 融合公式与参数 alpha rrfK bothBoost 推导",
    null),
  entry("g-feat-01-c3", "document", "feature_chunk", 40,
    "F20260902rcp1 chunk：rerank 信号堆叠与文档层半衰期 90 天分层",
    null),
  entry("g-feat-02", "document", "feature", 100,
    "F20260826rcmp 检索埋点：search-query-log 落库 query 与结果和中间分值，支持 debug 通道导出",
    null),
  entry("g-feat-02-c1", "document", "feature_chunk", 100,
    "F20260826rcmp chunk：埋点表结构与采样策略",
    null),
  entry("g-res-01", "document", "research", 75,
    "记忆召回评测调研：nDCG MRR Recall 指标选型，golden 集方法论，业界 IR 评测实践综述",
    null),
  entry("g-res-01-c1", "document", "research_chunk", 75,
    "评测调研 chunk：nDCG 分级增益与标注一致性",
    null),
  entry("g-res-02", "document", "research", 200,
    "embedding 版本锚研究：modelId modelRev dim 校验与静默降级风险分析",
    null),
  entry("g-res-02-c1", "document", "research_chunk", 200,
    "版本锚研究 chunk：mismatch 场景分析与存量基线重写时机",
    null),
  entry("g-feat-03", "document", "feature", 20,
    "F20260917cvid 本对话加成：currentConversationBoost 1.5，命中本对话条目排序乘加成",
    null),
  entry("g-feat-04", "document", "feature", 160,
    "F20260812mrcq anchor 检索：F/R 文档 ID 正则子串匹配，ID 加限定词模式",
    null),
  entry("g-feat-05", "document", "feature", 260,
    "F20260805hybrid jieba 中文分词接入：停用词过滤与 doubleWrite 策略",
    null),
  entry("g-feat-06", "document", "feature", 10,
    "F20260803fbit contentType 过滤：按内容类型多选过滤，防 summary 与 body 互删",
    null),
  entry("g-res-03", "document", "research", 300,
    "半衰期分层研究：working 7 天与 document 90 天的双时间常数设计依据",
    null),
  entry("g-feat-07", "document", "feature", 55,
    "F20260803chunk 多 chunk 聚合：按 source 去重与 chunk 最高分代表排序",
    null),

  // ── 近邻干扰簇（v2 扩充，检视发现 2 处置：压候选池过窄问题）──
  // 每簇同一主题多侧面条目：FTS 词汇重叠高难区分，期望排序由 rerank 信号
  // （本对话加成/新鲜度/标记）决定——让基线对排序质量敏感，而不只是召回存在性。

  // 簇1：worktree 主题三侧面（越狱 1/90 天 vs 本对话 4 天）
  entry("g-clu-01a", "historical", "message", 90,
    "对话记录：worktree 清理规范讨论——合入后删除 worktree 目录与远程分支的时机，留在旧对话",
    CONV_GAMMA),
  entry("g-clu-01b", "working", "message", 4,
    "本对话：worktree 隔离红线重申——主目录只读，改动全部在 feature 分支 worktree 内提交",
    CONV_ALPHA),
  entry("g-clu-01c", "historical", "message", 30,
    "对话记录：worktree 命名规范讨论——特性分支与 worktree 目录同名便于追踪",
    CONV_BETA),

  // 簇2：评测主题三侧面（查询在 alpha，最新答案在 alpha）
  entry("g-clu-02a", "historical", "message", 60,
    "对话记录：旧评测方案讨论——当时想用人工评分，后来废弃",
    CONV_GAMMA),
  entry("g-clu-02b", "working", "message", 2,
    "本对话：评测指标定为 nDCG 与 MRR，回归地板进 CI",
    CONV_ALPHA),
  entry("g-clu-02c", "historical", "message", 45,
    "对话记录：评测语料讨论——合成种子集定案，真实数据校准待定",
    CONV_BETA),

  // 簇3：部署/CI 主题（fact 层，新鲜度区分：当前 7 天 vs 旧 120 天）
  entry("g-clu-03a", "historical", "fact", 120,
    "旧部署流程：手动 npm test 后人工合并，现已废弃",
    null),
  entry("g-clu-03b", "working", "fact", 7,
    "当前 CI 门禁：check/e2e/golden-selftest 三 job 全绿才可合入，PR 须与 main 同步",
    null),
  entry("g-clu-03c", "historical", "fact", 90,
    "CI 历史事故：日期炸弹 #1165 因 lint 收窄误报刷屏被无视，次日引爆主分支",
    null),

  // 簇4：记忆分层主题（fact 层，新鲜度区分 + 弱干扰）
  entry("g-clu-04a", "historical", "fact", 200,
    "旧分层方案：两分层 working/archive，后改为三层引入 document",
    null),
  entry("g-clu-04b", "working", "fact", 5,
    "当前分层：working 7 天半衰期、document 90 天半衰期，时间衰减按层取常数",
    null),

  // 簇5：检索主题（message 层，本对话加成区分）
  entry("g-clu-05a", "historical", "message", 70,
    "旧对话：检索慢的抱怨——大库上 FTS 查询延迟高，后来建了索引",
    CONV_GAMMA),
  entry("g-clu-05b", "working", "message", 3,
    "本对话：检索排序评测的 runner 跑通全链路，指标稳定",
    CONV_ALPHA),
];

/** 权重预设：fact-06 搭档标记（user_flag 信号）；fact-01/fact-06 有检索历史（frequency 信号） */
export const WEIGHT_PRESETS: WeightPreset[] = [
  { entryId: "g-fact-06", userFlagged: true, retrievalCount: 5 },
  { entryId: "g-fact-01", retrievalCount: 3 },
  { entryId: "g-clu-03b", retrievalCount: 4 }, // 簇3：当前 CI 门禁事实常被引用（frequency 区分）
];

/** ── golden 查询集（32 条，四层分层）────────────────────────── */

export type QueryLayer = "fact" | "history" | "document" | "conversation" | "probe";

export interface GoldenQuery {
  id: string;
  layer: QueryLayer;
  query: string;
  /** Layer D 查询注入当前对话 ID（conversation_boost 信号覆盖） */
  currentConversationId?: string;
  /** 期望相关性：entryId → 分级（1-3）。未标注条目视为 0 */
  expected: Record<string, number>;
}

export const GOLDEN_QUERIES: GoldenQuery[] = [
  // A. 事实定位（8 条）
  { id: "A1", layer: "fact", query: "worktree 红线 主目录 改动",
    expected: { "g-fact-01": 3, "g-fact-02": 1 } },
  { id: "A2", layer: "fact", query: "commit 提交信息 前缀 规范",
    expected: { "g-fact-02": 3, "g-fact-01": 1 } },
  { id: "A3", layer: "fact", query: "sqlite-vec 降级 纯 FTS 检索",
    expected: { "g-fact-03": 3, "g-fact-04": 2 } },
  { id: "A4", layer: "fact", query: "中文分词 jieba 查询",
    expected: { "g-fact-04": 3, "g-feat-05": 2 } },
  { id: "A5", layer: "fact", query: "RRF 融合 参数 alpha",
    expected: { "g-fact-05": 3, "g-feat-01-c2": 2 } },
  { id: "A6", layer: "fact", query: "rerank 信号 堆叠 乘法",
    expected: { "g-fact-06": 3, "g-feat-01-c3": 2 } },
  { id: "A7", layer: "fact", query: "bge-m3 向量 维度 模型",
    expected: { "g-fact-08": 3 } },
  { id: "A8", layer: "fact", query: "记忆层 document 状态转换",
    expected: { "g-fact-10": 3 } },

  // B. 历史脉络（8 条）
  { id: "B1", layer: "history", query: "排序优化 为什么 先做 评测基线",
    expected: { "g-msg-01": 3, "g-fact-07": 2 } },
  { id: "B2", layer: "history", query: "文档轮 审视 处置 结论",
    expected: { "g-msg-02": 3 } },
  { id: "B3", layer: "history", query: "#944 测试库 vec 表 教训",
    expected: { "g-msg-03": 3, "g-fact-03": 2 } },
  { id: "B4", layer: "history", query: "日期炸弹 lint 规则 收窄",
    expected: { "g-msg-04": 3, "g-msg-06": 2 } },
  { id: "B5", layer: "history", query: "检索 埋点 debug 分值",
    expected: { "g-msg-05": 3, "g-feat-02": 2 } },
  { id: "B6", layer: "history", query: "动态日期 相对时间 fixture 模式",
    expected: { "g-msg-06": 3, "g-msg-04": 1 } },
  { id: "B7", layer: "history", query: "#1133 Phase 0 实现 范围",
    expected: { "g-msg-07": 3, "g-msg-08": 2 } },
  { id: "B8", layer: "history", query: "评测 runner 测试基建 全链路",
    expected: { "g-msg-08": 3, "g-msg-07": 2 } },

  // C. 文档检索（10 条）
  { id: "C1", layer: "document", query: "混合检索 架构 设计",
    expected: { "g-feat-01": 3, "g-feat-01-c1": 2, "g-feat-01-c2": 2, "g-feat-01-c3": 1 } },
  { id: "C2", layer: "document", query: "RRF 融合 公式 推导",
    expected: { "g-feat-01-c2": 3, "g-feat-01": 2, "g-fact-05": 2 } },
  { id: "C3", layer: "document", query: "rerank 半衰期 文档层 分层",
    expected: { "g-feat-01-c3": 3, "g-res-03": 2 } },
  { id: "C4", layer: "document", query: "埋点 search query log 采样",
    expected: { "g-feat-02": 3, "g-feat-02-c1": 2 } },
  { id: "C5", layer: "document", query: "评测 指标 选型 调研",
    expected: { "g-res-01": 3, "g-res-01-c1": 2 } },
  { id: "C6", layer: "document", query: "nDCG 分级增益 标注 一致性",
    expected: { "g-res-01-c1": 3, "g-res-01": 2, "g-fact-07": 1 } },
  { id: "C7", layer: "document", query: "embedding 版本锚 mismatch",
    expected: { "g-res-02": 3, "g-res-02-c1": 2, "g-fact-08": 2 } },
  { id: "C8", layer: "document", query: "本对话 加成 currentConversationBoost",
    expected: { "g-feat-03": 3 } },
  { id: "C9", layer: "document", query: "F/R 文档 ID anchor 匹配",
    expected: { "g-feat-04": 3 } },
  { id: "C10", layer: "document", query: "jieba 停用词 doubleWrite",
    expected: { "g-feat-05": 3, "g-fact-04": 2 } },

  // D. 本对话主题（6 条，注入 currentConversationId）
  { id: "D1", layer: "conversation", query: "golden 语料 时间戳 设计",
    currentConversationId: CONV_ALPHA,
    expected: { "g-msg-09": 3, "g-fact-09": 2 } },
  { id: "D2", layer: "conversation", query: "回归地板 CI 门禁",
    currentConversationId: CONV_ALPHA,
    expected: { "g-msg-10": 3 } },
  { id: "D3", layer: "conversation", query: "指标模块 单测 锁定",
    currentConversationId: CONV_ALPHA,
    expected: { "g-msg-07": 3, "g-msg-08": 1 } },
  { id: "D4", layer: "conversation", query: "评测 全链路 覆盖",
    currentConversationId: CONV_ALPHA,
    expected: { "g-msg-08": 3, "g-msg-10": 1 } },
  { id: "D5", layer: "conversation", query: "排序 评测 基线 锁定",
    currentConversationId: CONV_ALPHA,
    expected: { "g-msg-10": 3, "g-msg-01": 2, "g-msg-11": 1 } },
  { id: "D6", layer: "conversation", query: "语料 contentType 时间 分布",
    currentConversationId: CONV_ALPHA,
    expected: { "g-msg-09": 3, "g-feat-06": 1 } },

  // E. 高区分度排序探针（v2 新增，检视发现 2 处置；layer=probe）
  // 特征：候选池 ≥3 条近邻干扰，FTS 词汇重叠难分；期望排序依赖 rerank 信号
  //（本对话加成/新鲜度/标记），把「排得好不好」与「能不能搜到」分开。
  { id: "E1", layer: "probe", query: "worktree 改动 提交 规范",
    currentConversationId: CONV_ALPHA,
    expected: { "g-clu-01b": 3, "g-fact-01": 2, "g-clu-01c": 1, "g-clu-01a": 1 } },
  { id: "E2", layer: "probe", query: "worktree 清理 时机",
    currentConversationId: CONV_ALPHA,
    expected: { "g-clu-01a": 3, "g-clu-01c": 2, "g-clu-01b": 1 } },
  { id: "E3", layer: "probe", query: "评测 指标 方案 讨论",
    currentConversationId: CONV_ALPHA,
    expected: { "g-clu-02b": 3, "g-clu-02c": 2, "g-clu-02a": 1 } },
  { id: "E4", layer: "probe", query: "评测 语料 谁来定",
    currentConversationId: CONV_ALPHA,
    expected: { "g-clu-02c": 3, "g-clu-02a": 1, "g-clu-02b": 2 } },
  { id: "E5", layer: "probe", query: "CI 门禁 合入 条件",
    expected: { "g-clu-03b": 3, "g-clu-03a": 1, "g-clu-03c": 2 } },
  { id: "E6", layer: "probe", query: "部署 流程 废弃 之前",
    expected: { "g-clu-03a": 3, "g-clu-03b": 1 } },
  { id: "E7", layer: "probe", query: "CI 事故 日期炸弹",
    expected: { "g-clu-03c": 3, "g-msg-04": 2 } },
  { id: "E8", layer: "probe", query: "记忆 分层 半衰期 当前",
    expected: { "g-clu-04b": 3, "g-clu-04a": 1, "g-fact-10": 2 } },
  { id: "E9", layer: "probe", query: "分层 方案 旧 两层",
    expected: { "g-clu-04a": 3, "g-clu-04b": 1 } },
  { id: "E10", layer: "probe", query: "检索 延迟 慢 抱怨",
    currentConversationId: CONV_ALPHA,
    expected: { "g-clu-05a": 3, "g-clu-05b": 1 } },
  { id: "E11", layer: "probe", query: "检索 排序 评测 稳定",
    currentConversationId: CONV_ALPHA,
    expected: { "g-clu-05b": 3, "g-msg-08": 2 } },
  { id: "E12", layer: "fact", query: "rerank 信号 哪个 标记",
    expected: { "g-fact-06": 3, "g-feat-01-c3": 2 } },
];

/** 探针层守卫数据：E 层查询的期望标注必须引用近邻干扰簇（区分度存在性） */
export const PROBE_CLUSTER_PREFIXES = ["g-clu-"] as const;
