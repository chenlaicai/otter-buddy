/**
 * F20261027hfup（M-5f45049e）：restoreHandoffContext 死键清除测试。
 *
 * 背景：restoreHandoffContext 曾强写 4 键（含 handoff_open_matters → ctx.openMatters），
 * 但 DynamicContext 接口与渲染函数均无 openMatters 字段——强写后静默丢弃。
 * 且 D8 演进后档案走 session.summary 单点写入，handoff_* 四键在生产无任何写入方（死代码面）。
 * 修法：撤除孤立的 handoff_open_matters 键（openMatters 走 archive 段直传，不借道 otter_context），
 * 并钉死「恢复仅覆盖健在的三借用式键」。
 */
import { describe, it, expect, vi } from "vitest";
import { restoreHandoffContext } from "@interface-adapters/agent-runtime/handoff-support";
import type { DynamicContext } from "@usecases/ports/sdk-invoke-port";
import type { ManageContext } from "@usecases/otter/manage-context";

function makeManageContext(store: Record<string, string>): ManageContext {
  return {
    get: vi.fn(async (_otterId: string, key: string) => ({ [key]: store[key] })),
    set: vi.fn(async () => {}),
    delete: vi.fn(async (_otterId: string, key: string) => {
      delete store[key];
    }),
  } as unknown as ManageContext;
}

describe("restoreHandoffContext（F20261027hfup 死键清除）", () => {
  it("三借用式键恢复进 DynamicContext 并消费即删", async () => {
    const store: Record<string, string> = {
      handoff_file_trail: "src/foo.ts 改了 3 次",
      handoff_recency_window: "近期原文片段",
      handoff_state_inventory: "活状态盘点",
    };
    const mc = makeManageContext(store);
    const ctx: DynamicContext = {};

    await restoreHandoffContext("otter-1", ctx, mc);

    expect(ctx.fileTrail).toBe("src/foo.ts 改了 3 次");
    expect(ctx.recencyWindow).toBe("近期原文片段");
    expect(ctx.stateInventory).toBe("活状态盘点");
    // 消费即删
    expect(store.handoff_file_trail).toBeUndefined();
    expect(store.handoff_recency_window).toBeUndefined();
    expect(store.handoff_state_inventory).toBeUndefined();
  });

  it("handoff_open_matters 不再被查询/强写（M-5f45049e：DynamicContext 无 openMatters 字段，强写=静默丢弃）", async () => {
    const store: Record<string, string> = {
      handoff_open_matters: "本对话未闭环事情（1 件）：1. [M-abcd1234] …",
    };
    const mc = makeManageContext(store);
    const ctx: DynamicContext = {};

    await restoreHandoffContext("otter-1", ctx, mc);

    // get 调用清单不含 handoff_open_matters（死键已撤——不再假装恢复它）
    const getMock = mc.get as ReturnType<typeof vi.fn>;
    const queriedKeys = getMock.mock.calls.map((c) => c[1] as string);
    expect(queriedKeys).not.toContain("handoff_open_matters");
    // ctx 上不存在 openMatters 字段（接口本就无此字段——openMatters 走档案段直传新世）
    expect("openMatters" in ctx).toBe(false);
    // 键未被消费删除（不是我们管的键，不动它）
    expect(store.handoff_open_matters).toBeDefined();
  });

  it("manageContext 缺省时直接返回（向后兼容）", async () => {
    const ctx: DynamicContext = {};
    await expect(restoreHandoffContext("otter-1", ctx, undefined)).resolves.toBeUndefined();
    expect(ctx.fileTrail).toBeUndefined();
  });
});
