/**
 * F20260825evgl: golden 场景最小 runner——软代码行为回归评测集的 PR gate 视图。
 *
 * 遍历 golden 场景 → 每场景按 sampling 采样（boot + sendUserMessage + waitForOtterMessage +
 * 场景自带命令式断言）→ 经 expectSampledBehavior 断言 → 每场景采样结束 append 一行到
 * results.jsonl（写入点在 runner，不动 expectSampledBehavior 本身）。
 *
 * F20260828gssf: selftest 层——跑真 LLM 采样之前，先把 good/bad 参考序列喂给断言函数
 * 离线校验判别力（good 必过 + bad 必拦）。selftest 不过直接 fail，不进入采样。
 * 零 LLM 依赖——参考消息序列纯构造，不发真实请求。
 *
 * 与现有 capability test 的关系：capability test = 源（详细断言/多采样/调试视图），
 * golden = PR gate 精简视图（精简采样 + 来源元数据 + 结果沉淀）。断言分叉时以 capability
 * test 为准，golden 跟随更新（见各场景 originTest 锚点）。
 *
 * 文件命名 *.golden.capability.test.ts 是为了匹配 vitest.capability.config.ts 的 include
 * 模式（tests/capability/**＼/*.capability.test.ts），让 golden 场景作为 B 类套件一部分真跑。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "../helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  listMessages,
  expectSampledBehavior,
  type MessageDto,
  type SampleResult,
} from "../helpers/assert-behavior";

/** golden 场景元数据（不发明声明式 DSL——断言是命令式函数，复用现有 helper） */
export interface GoldenScenario {
  id: string;
  /** 伤疤来源：真实问题记录的锚点，可追溯 */
  source: { type: "scar" | "trace" | "healing"; ref: string };
  /** 源测试锚点：断言逻辑跟随此测试更新，分叉时以此为准 */
  originTest: string;
  /** 输入场景：真实对话形态的用户消息 */
  input: string;
  /** 采样协议：PR gate 精简版 */
  sampling: { n: number; minSuccess: number };
  /** 模型版本标签：本场景最后校准时的模型 */
  modelTag: string;
  /** 软行为场景：trajectory 断言覆盖不了，跑完由检视獭人工判定 */
  manualReview: boolean;
}

/** 场景断言函数的上下文：boot 装配 + 本次采样的消息历史 */
export interface GoldenAssertCtx {
  ctx: CapabilityContext;
  convId: string;
  messages: MessageDto[];
}

/** 命令式断言：返回 SampleResult 契约 */
export type GoldenAssert = (ac: GoldenAssertCtx) => Promise<SampleResult>;

/** F20260828gssf: selftest 参考序列——一条 good/bad 的完整定义 */
export interface GoldenSelftestRef {
  /** 构造的参考消息序列（零 LLM 调用，纯数据构造） */
  messages: MessageDto[];
  /** 期望断言结果：true=应 ok（good 行为），false=应 !ok（bad 行为） */
  expectedOk: boolean;
  /** 覆盖默认 convId（factory 场景创建会话后回传的 convId，见 talking-stone-routing） */
  convId?: string;
}

/** F20260828gssf: selftest 定义——每个场景配 good/bad 参考。
 *  bad 支持数组：多条 bad 轨迹覆盖不同退化形态（如 r4 缺 search_memory + 顺序颠倒）。
 *  runner 对每条 bad 独立校验，任一通过（expectedOk 匹配失败）即判别力不足。 */
export interface GoldenSelftest {
  good: GoldenSelftestRef;
  bad: GoldenSelftestRef | GoldenSelftestRef[];
}

export interface GoldenModule {
  golden: GoldenScenario;
  assert: GoldenAssert;
  /** manualReview 场景的判定提示（供检视獭参考，复用源测试既有判据） */
  manualReviewHint?: string;
  /** F20260828gssf: selftest 参考。静态对象或 factory 函数（DB 依赖场景）。
   *  bad 支持数组——多条 bad 轨迹覆盖不同退化形态，runner 独立校验每条。 */
  selftest?: GoldenSelftest | ((ctx: CapabilityContext) => Promise<GoldenSelftest>);
}

/** results.jsonl 写入点（非 git 追踪，本地数据沉淀）
 *  v6.3 P0-b: 默认解析主仓根（git rev-parse --git-common-dir），防 worktree 孤岛写入。
 *  env GOLDEN_RESULTS_PATH 可显式覆盖。 */
function resolveResultsPath(): string {
  const envPath = process.env.GOLDEN_RESULTS_PATH;
  if (envPath) return envPath;

  // git rev-parse --git-common-dir 在 worktree 中返回主仓 .git 路径
  let gitCommonDir: string;
  try {
    gitCommonDir = execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim();
  } catch {
    // fallback: 当前目录（非 git 环境）
    return path.join(__dirname, "results.jsonl");
  }

  // git-common-dir 可能是相对路径（如 .git），需要解析为绝对路径
  const resolved = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(process.cwd(), gitCommonDir);

  // 推导主仓根目录（.git 的父目录）
  const repoRoot = path.dirname(resolved);

  // fail-fast: 写入目标不在主仓根下 → 报错拒跑（防 worktree 孤岛写入）
  const targetDir = path.join(repoRoot, "data", "metrics");
  if (!targetDir.startsWith(repoRoot)) {
    throw new Error(`[golden] results.jsonl 写入目标不在主仓根下：${targetDir}（主仓根：${repoRoot}）`);
  }

  return path.join(targetDir, "golden-results.jsonl");
}

const RESULTS_PATH = resolveResultsPath();

function appendResult(record: Record<string, unknown>): void {
  try {
    // 确保目录存在
    const dir = path.dirname(RESULTS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(RESULTS_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    /** 结果沉淀失败不阻断 gate——assert 已通过 expectSampledBehavior 判定，
     *  记一行警告即可，避免本地文件系统问题把 PR 打红 */
    console.warn(`[golden] results.jsonl 写入失败（不阻断）：${err instanceof Error ? err.message : err}`);
  }
}

/** 当前 PR 号（GitHub Actions 注入；本地跑为 undefined） */
function currentPr(): number | undefined {
  const ref = process.env.GITHUB_REF ?? "";
  const m = ref.match(/refs\/pull\/(\d+)\//);
  return m ? Number(m[1]) : undefined;
}

/** F20260828gssf: selftest 结果 */
export interface SelftestResult {
  passed: boolean;
  reason?: string;
  goodOk?: boolean;
  badOk?: boolean;
}

/**
 * F20260828gssf: 运行 selftest——校验断言函数对 good/bad 参考序列的判别力。
 * 零 LLM 调用，纯离线校验。判别力不足（两个都过或两个都拦）直接 fail。
 */
export async function runSelftest(
  ctx: CapabilityContext,
  mod: GoldenModule,
): Promise<SelftestResult> {
  if (!mod.selftest) {
    return { passed: true };
  }

  const selftestDef = typeof mod.selftest === "function"
    ? await mod.selftest(ctx)
    : mod.selftest;

  const defaultConvId = `selftest:${mod.golden.id}`;

  const goodResult = await mod.assert({
    ctx,
    convId: selftestDef.good.convId ?? defaultConvId,
    messages: selftestDef.good.messages,
  });

  const goodOk = goodResult.ok === selftestDef.good.expectedOk;

  // bad 支持数组：多条 bad 轨迹独立校验，任一失败即判别力不足
  const badRefs = Array.isArray(selftestDef.bad) ? selftestDef.bad : [selftestDef.bad];
  let allBadOk = true;
  let firstBadActualOk: boolean | undefined;
  let firstBadFailure: { actual: boolean; expected: boolean } | undefined;

  for (const badRef of badRefs) {
    const badResult = await mod.assert({
      ctx,
      convId: badRef.convId ?? defaultConvId,
      messages: badRef.messages,
    });
    const badOk = badResult.ok === badRef.expectedOk;
    if (firstBadActualOk === undefined) firstBadActualOk = badResult.ok;
    if (!badOk && allBadOk) {
      allBadOk = false;
      firstBadFailure = { actual: badResult.ok, expected: badRef.expectedOk };
    }
  }

  const passed = goodOk && allBadOk;

  return {
    passed,
    goodOk: goodResult.ok,
    badOk: firstBadActualOk ?? false,
    reason: passed
      ? undefined
      : `判别力不足：good.ok=${goodResult.ok}(expect ${selftestDef.good.expectedOk})${firstBadFailure ? ` bad.ok=${firstBadFailure.actual}(expect ${firstBadFailure.expected})` : ""}`,
  };
}

/**
 * 注册一组 golden 场景为一个 vitest describe 块。
 * 各场景文件导出 GoldenModule，这里统一 boot 一次、逐场景采样断言。
 */
export function registerGoldenScenarios(modules: GoldenModule[]): void {
  describe("golden 场景集：软代码行为回归（PR gate 精简视图）", () => {
    let ctx: CapabilityContext;

    beforeAll(async () => {
      ctx = await bootCapabilityApp();
    });

    afterAll(() => {
      ctx?.cleanup();
    });

    for (const mod of modules) {
      const { golden, assert } = mod;
      const label = `golden:${golden.id}`;

      it(`${golden.id}（n=${golden.sampling.n} ≥${golden.sampling.minSuccess}，源 ${golden.originTest}）`, async (t) => {
        /** F20260828gssf: selftest 前置校验——不依赖 LLM，无论 LLM 是否可用都跑。
         *  判别力不足时直接 fail，不进入采样（"仪器先证明可靠才花钱"）。 */
        if (mod.selftest) {
          const selftestResult = await runSelftest(ctx, mod);

          appendResult({
            ts: new Date().toISOString(),
            golden_id: `${golden.id}:selftest`,
            selftest: true,
            passed: selftestResult.passed,
            good_ok: selftestResult.goodOk,
            bad_ok: selftestResult.badOk,
            pr: currentPr(),
            ...(selftestResult.reason ? { reason: selftestResult.reason } : {}),
          });

          expect(
            selftestResult.passed,
            `selftest 失败：${golden.id} 断言函数判别力不足——${selftestResult.reason}`,
          ).toBe(true);
        }

        if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

        /** manualReview 场景不自动断言——跑完输出标记，由检视獭按 manualReviewHint 人工判定 */
        if (golden.manualReview) {
          await runOneSample(ctx, golden, assert);
          console.log(`MANUAL_REVIEW: ${golden.id}${mod.manualReviewHint ? ` —— 判定提示：${mod.manualReviewHint}` : ""}`);
          appendResult({
            ts: new Date().toISOString(),
            golden_id: golden.id,
            model: golden.modelTag,
            n: golden.sampling.n,
            successes: null,
            pr: currentPr(),
            manual: true,
            verdict: "pending",
            passed: null, // manualReview 行不参与零 fail 统计（v6.3，mimo 新发现 2 + glm-flash 发现 7）
          });
          return;
        }

        let successes = 0;
        await expectSampledBehavior(label, golden.sampling.n, golden.sampling.minSuccess, async () => {
          const r = await runOneSample(ctx, golden, assert);
          if (r.ok) successes++;
          return r;
        });

        appendResult({
          ts: new Date().toISOString(),
          golden_id: golden.id,
          model: golden.modelTag,
          n: golden.sampling.n,
          successes,
          pr: currentPr(),
          manual: false,
          passed: successes >= golden.sampling.minSuccess, // 自动场景 passed = successes >= minSuccess（v6.3，mimo 新发现 2 + glm-flash 发现 7）
        });
      }, 1_800_000); // 30 分钟超时（采样 × 每轮完整 agent 回合 ~30-60s）
    }
  });
}

/** 跑一轮采样：建会话 → 发输入 → 等回合终局 → 命令式断言 */
async function runOneSample(
  ctx: CapabilityContext,
  golden: GoldenScenario,
  assert: GoldenAssert,
): Promise<SampleResult> {
  const convId = await createConversation(ctx, `golden:${golden.id}`);
  await sendUserMessage(ctx, convId, golden.input);
  await waitForOtterMessage(ctx, convId, { timeoutMs: 300_000 });
  const messages = await listMessages(ctx, convId);
  return assert({ ctx, convId, messages });
}
