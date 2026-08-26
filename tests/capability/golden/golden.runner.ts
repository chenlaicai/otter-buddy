/**
 * F20260825evgl: golden 场景最小 runner——软代码行为回归评测集的 PR gate 视图。
 *
 * 遍历 golden 场景 → 每场景按 sampling 采样（boot + sendUserMessage + waitForOtterMessage +
 * 场景自带命令式断言）→ 经 expectSampledBehavior 断言 → 每场景采样结束 append 一行到
 * results.jsonl（写入点在 runner，不动 expectSampledBehavior 本身）。
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
import { describe, it, beforeAll, afterAll } from "vitest";
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

export interface GoldenModule {
  golden: GoldenScenario;
  assert: GoldenAssert;
  /** manualReview 场景的判定提示（供检视獭参考，复用源测试既有判据） */
  manualReviewHint?: string;
}

/** results.jsonl 写入点（非 git 追踪，本地数据沉淀） */
const RESULTS_PATH = path.join(__dirname, "results.jsonl");

function appendResult(record: Record<string, unknown>): void {
  try {
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
