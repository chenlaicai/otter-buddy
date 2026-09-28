/**
 * #1187：expectSampledBehavior 墙钟预算回归测试。
 * 保护两个语义：
 * 1. 前瞻拦截——elapsed + sampleWorstMs > budgetMs 时剩余采样 SKIP（不跑，不进分母）
 * 2. 无预算——行为与原版一致（全部采样跑完）
 * 3. SKIP 后断言方向——successes 不变，不足 minSuccess 时红
 */
import { describe, it } from "vitest";
import { expectSampledBehavior } from "./capability/helpers/assert-behavior";

describe("expectSampledBehavior budgetMs（#1187）", () => {
  it("前瞻拦截：预算 900ms、worst 500ms、3 采各 300ms——#1/#2 跑，#3 前瞻拦截（600+500>900）", async () => {
    let ran = 0;
    await expectSampledBehavior("budget-forward", 3, 1, async (i) => {
      ran++;
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true, detail: `#${i + 1}` };
    }, { budgetMs: 900, sampleWorstMs: 500 });
    // #1 起跑 elapsed≈0；#2 起跑 elapsed≈300（300+500<900 跑）；#3 起跑 elapsed≈600（600+500>900 SKIP）
    if (ran > 2) throw new Error(`前瞻未生效：ran=${ran}（应 ≤2）`);
  }, 10_000);

  it("在途保护对齐检视语义：worst=实际耗时上限时，最后样本不越预算", async () => {
    let ran = 0;
    await expectSampledBehavior("budget-tail", 2, 1, async (i) => {
      ran++;
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, detail: `#${i + 1}` };
    }, { budgetMs: 1000, sampleWorstMs: 400 });
    // #1 elapsed 0；#2 elapsed 400（400+400<1000 跑）——两个都跑，总耗时 800 ≤ 1000
    if (ran !== 2) throw new Error(`ran=${ran} 应为 2（worst 精确时不误拦）`);
  }, 10_000);

  it("无 budgetMs：行为不变，全部采样执行", async () => {
    let ran = 0;
    await expectSampledBehavior("no-budget", 3, 3, async (i) => {
      ran++;
      return { ok: true, detail: `#${i + 1}` };
    });
    if (ran !== 3) throw new Error(`ran=${ran} 应为 3`);
  }, 5_000);

  it("SKIP 后 successes 不足 minSuccess 时断言红（方向保护）", async () => {
    let assertionError: unknown;
    try {
      await expectSampledBehavior("skip-red", 3, 2, async () => {
        await new Promise((r) => setTimeout(r, 350));
        return { ok: true, detail: "x" };
      }, { budgetMs: 500, sampleWorstMs: 350 });
    } catch (err) {
      assertionError = err;
    }
    // 预算 500/worst 350：#1 跑（0+350<500）、#2 拦（350+350>500）→ ran=1 < minSuccess 2 → 必红
    if (!assertionError) throw new Error("SKIP 致采样不足时应断言红，未抛错");
    const msg = String(assertionError);
    if (!msg.includes("SKIP")) throw new Error(`断言消息应含 SKIP 明细：${msg.slice(0, 200)}`);
  }, 10_000);
});
