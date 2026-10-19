/**
 * #1540（F20261019kbpc）dual-chain 文案锚——V2 模型判定链（guard-model-judge）专用。
 *
 * 背景：同文案曾有 4+2 处拷贝（V1 bash-safety-guard / V2 guard-model-judge 各自持有），
 * 实现期实证「只改 V1 时 V2 路径返回旧文案」的静默漂移。收口 kill-block-messages.ts
 * 唯一文案源后，本文件锁定 V2 链确实消费共享文案（wiring 锚）——未来有人把文案
 * 再内联回 judge 层时这里会红。
 *
 * 检验对象：checkWithModel（V2 判定总入口，bash-safety-guard checkBashCommandSafety
 * 经 checkWithModel 调用——issue 根因恰是 V2 漂移，故 V2 链必须有独立锚点）。
 */
import { describe, expect, it } from "vitest";
import { checkWithModel } from "../../../src/frameworks/agent/guard-model-judge";
import {
  INDIRECT_KILL_BLOCK_MSG,
  PKILL_BYNAME_BLOCK_MSG,
} from "../../../src/frameworks/agent/kill-block-messages";

const KILL_BY_PID_EXAMPLE = "node scripts/restart-service.mjs kill-by-pid <pid> --project /abs/path";

describe("#1540 V2 链文案锚（guard-model-judge → kill-block-messages 唯一文案源）", () => {
  it("V2 非字面 PID kill 返回共享文案（恒等锁定，含 kill-by-pid 完整示例串）", () => {
    const result = checkWithModel("kill $(lsof -ti :3000)", 11111);
    expect(result).toBe(INDIRECT_KILL_BLOCK_MSG);
    expect(result).toContain(KILL_BY_PID_EXAMPLE);
  });

  it("V2 pkill 按名批量终止返回共享文案（恒等锁定）", () => {
    const result = checkWithModel("pkill node", 11111);
    expect(result).toBe(PKILL_BYNAME_BLOCK_MSG);
    expect(result).toContain(KILL_BY_PID_EXAMPLE);
  });
});
