/**
 * 能力测试：A3 模型可见内容重建比对（R20260817dshp / issue #289，PR-C 前置）。
 *
 * 机制：boot 指向本地录音网关（伪 anthropic 端点），SDK 全链路照常发真实请求——
 * wire 级请求体即模型可见输入的最终真相（system + messages + tools）。
 * 网关回放脚本化 speak+yield 响应驱动确定性对话。录音 → 规范化 → 快照。
 *
 * 三种运行模式：
 * - 默认（无环境变量）：结构健全性 + 规范化确定性自检——CI 常规价值
 * - A3_SNAPSHOT_CAPTURE=<file>：写基线快照（在基线分支/旧代码上跑）
 * - A3_SNAPSHOT_FILE=<file>：与基线快照逐字段比对（在重构分支上跑）——
 *   重构工作流：旧分支 capture → 新分支 compare，diff 为空 = 模型所见零漂移
 *
 * 注：本用例走录音网关而非真 LLM 端点（确定性要求），与 llmAvailable skip 逻辑无关。
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  listMessages,
  latestUserSeq,
} from "./helpers/assert-behavior";
import {
  RecordingGateway,
  speakScript,
  yieldScript,
  canonicalizeRequests,
  stableStringify,
  diffCanonical,
  buildSnapshot,
  writeSnapshot,
  readSnapshot,
} from "./helpers/model-visible";

const SCENARIO = "model-visible-parity-v1";

describe("A3: 模型可见内容重建比对（录音网关确定性场景）", () => {
  let gateway: RecordingGateway;
  let ctx: CapabilityContext;

  beforeAll(async () => {
    gateway = await RecordingGateway.start();
    gateway.queue([
      speakScript("第一轮固定答复：收到，一切正常。"),
      yieldScript(),
      speakScript("第二轮固定答复：任务完成。"),
      yieldScript(),
    ]);
    ctx = await bootCapabilityApp({ recordingGatewayUrl: gateway.url });
  });

  afterAll(async () => {
    ctx?.cleanup();
    await gateway?.stop();
  });

  it("两轮对话捕获 2 次模型请求，输入结构健全", async () => {
    const convId = await createConversation(ctx, "A3 比对场景");
    await sendUserMessage(ctx, convId, "A3-第一轮：请直接收尾，不需要工具。");
    const first = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000 });
    expect(first.status).toBe("completed");

    /** 锚定第二轮 user 消息的 seq：waitForOtterMessage 的 afterSeq 必须越过第一轮的全部消息
     *  （锚第一轮 user 的 seq 会误匹配第一轮 otter 的 completed） */
    await sendUserMessage(ctx, convId, "A3-第二轮：再次收尾。");
    const userSeq2 = latestUserSeq((await listMessages(ctx, convId)).filter((m) => m.st === "user"));
    const second = await waitForOtterMessage(ctx, convId, { timeoutMs: 120_000, afterSeq: userSeq2 });
    expect(second.status).toBe("completed");

    /** speak+yield 拆分：每轮 = speak 请求 + yield 请求（speak 不终止回合） */
    expect(gateway.requests.length).toBe(4);

    /** 第 1 次请求：system 非空、工具表含 speak 与 yield、消息含本轮 user 输入 */
    const r0 = gateway.requests[0] as {
      system?: unknown;
      tools?: Array<{ name: string }>;
      messages?: unknown[];
    };
    /** 消费者观测点：durable 首轮必须把身份/system prompt 真正送到 wire；
     *  仅断言动态 user envelope 或工具列表会让「身份静默消失」假绿。
     *  基线 capture 的职责是如实记录旧行为，不用当前分支新断言拦死捕获。 */
    if (!process.env.A3_SNAPSHOT_CAPTURE) {
      expect(JSON.stringify(r0.system ?? "").length).toBeGreaterThan(100);
      expect(JSON.stringify(r0.system ?? "")).toContain("大獭");
      expect(JSON.stringify(r0.system ?? "")).toContain("<available_skills>");
      expect(JSON.stringify(r0.system ?? "")).toContain("requirement-analysis");
    }
    expect(r0.tools?.map((t) => t.name)).toContain("speak");
    expect(r0.tools?.map((t) => t.name)).toContain("yield");
    expect(JSON.stringify(r0.messages)).toContain("A3-第一轮");

    /** 第 3 次请求（第二轮 speak）：上下文累积——含第 1 轮 speak/yield tool_use、其 tool_result、新的 user 输入 */
    const r2dump = JSON.stringify(gateway.requests[2]);
    expect(r2dump).toContain("speak");
    expect(r2dump).toContain("yield");
    expect(r2dump).toContain("tool_result");
    expect(r2dump).toContain("A3-第二轮");
  }, 300_000);

  it("规范化确定性：同一份原始请求两次规范化结果完全一致", () => {
    const a = canonicalizeRequests(gateway.requests, { tmpDir: ctx.tmpDir });
    const b = canonicalizeRequests(gateway.requests, { tmpDir: ctx.tmpDir });
    expect(stableStringify(a)).toBe(stableStringify(b));
    /** 规范化确实发生了：快照里不含原始 tmpDir 路径与裸 UUID */
    const dump = stableStringify(a);
    expect(dump).not.toContain(ctx.tmpDir);
    expect(dump).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("跨分钟执行与历史条数变化不产生本地时间假阳性", () => {
    const before = canonicalizeRequests([
      { messages: [{ content: "当前时间 2026-11-10 18:01（Asia/Shanghai）；历史（10/11 18:01）" }] },
    ], { tmpDir: ctx.tmpDir });
    const after = canonicalizeRequests([
      { messages: [{ content: "较早请求（10/11 18:00）" }] },
      { messages: [{ content: "当前时间 2026-11-10 18:02（Asia/Shanghai）；历史（10/11 18:02）" }] },
    ], { tmpDir: ctx.tmpDir });
    expect(JSON.stringify(after)).toContain("<LOCAL_TS>");
    expect(JSON.stringify(after)).not.toContain("<LOCAL_TS:4>");
    expect(diffCanonical(before, [after[1]])).toEqual([]);
  });

  it("修改字段的许可包含双侧完整指纹，共同前缀之外的变化不能复用", () => {
    const prefix = "x".repeat(160);
    const first = diffCanonical([{ value: `${prefix}-a` }], [{ value: `${prefix}-b` }]);
    const changed = diffCanonical([{ value: `${prefix}-a` }], [{ value: `${prefix}-c` }]);
    expect(first[0]).toMatch(/sha256:[0-9a-f]{64}.*sha256:[0-9a-f]{64}/);
    expect(changed).not.toEqual(first);
  });

  it("快照模式：A3_SNAPSHOT_CAPTURE 写基线 / A3_SNAPSHOT_FILE 逐字段比对", () => {
    const canonical = canonicalizeRequests(gateway.requests, { tmpDir: ctx.tmpDir });

    const captureTo = process.env.A3_SNAPSHOT_CAPTURE;
    if (!captureTo && !process.env.A3_SNAPSHOT_FILE) {
      /** 默认模式也不能空跑：至少断言快照规模（防 vacuous pass） */
      expect(canonical.length).toBe(4);
      return;
    }
    if (captureTo) {
      writeSnapshot(captureTo, buildSnapshot(SCENARIO, canonical));
      console.log(`[A3] 基线快照已写入 ${captureTo}（${canonical.length} 次请求）`);
      return;
    }

    const compareWith = process.env.A3_SNAPSHOT_FILE;
    if (compareWith) {
      const snap = readSnapshot(compareWith);
      expect(snap.scenario, `快照场景不匹配：期望 ${SCENARIO}，实际 ${snap.scenario}`).toBe(SCENARIO);
      const diffs = diffCanonical(snap.canonical, canonical);
      /** 有意变化必须按基线 commit 预先登记精确 diff；许可由 run-capability-parity.sh
       *  从 parity-allowlist.json 选取，其他基线/未来 PR 不继承。 */
      const allowFile = process.env.A3_SNAPSHOT_ALLOW_FILE;
      const allowed = allowFile
        ? JSON.parse(fs.readFileSync(allowFile, "utf8")) as string[]
        : [];
      const unexpected = diffs.filter(diff => !allowed.includes(diff));
      expect(
        unexpected,
        `模型可见输入出现未登记漂移（${unexpected.length} 处）：\n${unexpected.join("\n")}`,
      ).toEqual([]);
      expect(allowed, "本基线登记的许可必须全部命中，防过期许可永久放行").toEqual(diffs);
      console.log(`[A3] 与基线 ${compareWith} 比对通过：${canonical.length} 次请求；未登记漂移 0，精确许可 ${allowed.length}`);
    }
  });
});
