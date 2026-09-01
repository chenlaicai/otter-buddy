/**
 * ChannelStatusRegistry 单元测试（F20260901chun 测试设计承诺）
 *
 * 断言 update/snapshot/clear/remove 的时序行为，
 * 验证 degraded/lastInboundAt 字段在 merge 中的保留策略。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryChannelStatusRegistry } from "@usecases/channel/channel-status-registry";

describe("InMemoryChannelStatusRegistry", () => {
  let registry: InMemoryChannelStatusRegistry;

  beforeEach(() => {
    registry = new InMemoryChannelStatusRegistry();
  });

  it("update + snapshot：写入条目后快照返回", () => {
    registry.update("weixin-acc1", { kind: "weixin", state: { kind: "running", since: 1000 } });
    const snap = registry.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ channelId: "weixin-acc1", kind: "weixin", state: { kind: "running", since: 1000 } });
  });

  it("update 同 channelId 幂等覆盖", () => {
    registry.update("feishu", { kind: "feishu", state: { kind: "running", since: 1000 } });
    registry.update("feishu", { kind: "feishu", state: { kind: "error_backoff", since: 2000, errorMsg: "WS 断线" } });
    const snap = registry.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].state.kind).toBe("error_backoff");
  });

  it("update merge 保留 degraded 字段：running + degraded → 再次 running 不丢失 degraded", () => {
    registry.update("weixin-orphan", { kind: "weixin", state: { kind: "running", since: 1000, degraded: true } });
    // 第二次 running（无 degraded 字段）应保留旧值
    registry.update("weixin-orphan", { kind: "weixin", state: { kind: "running", since: 2000 } });
    const snap = registry.snapshot();
    expect(snap[0].state).toMatchObject({ kind: "running", since: 2000, degraded: true });
  });

  it("update merge 保留 lastInboundAt：running + lastInboundAt → 再次 running 无 lastInboundAt 保留旧值", () => {
    registry.update("weixin-acc1", { kind: "weixin", state: { kind: "running", since: 1000, lastInboundAt: 1500 } });
    registry.update("weixin-acc1", { kind: "weixin", state: { kind: "running", since: 2000 } });
    const snap = registry.snapshot();
    expect(snap[0].state).toMatchObject({ kind: "running", since: 2000, lastInboundAt: 1500 });
  });

  it("remove 删除条目", () => {
    registry.update("weixin-acc1", { kind: "weixin", state: { kind: "running", since: 1000 } });
    registry.remove("weixin-acc1");
    expect(registry.snapshot()).toHaveLength(0);
  });

  it("remove 不存在的条目不报错", () => {
    registry.remove("nonexistent");
    expect(registry.snapshot()).toHaveLength(0);
  });

  it("clear 清空所有条目", () => {
    registry.update("weixin-acc1", { kind: "weixin", state: { kind: "running", since: 1000 } });
    registry.update("feishu", { kind: "feishu", state: { kind: "running", since: 2000 } });
    registry.clear();
    expect(registry.snapshot()).toHaveLength(0);
  });

  it("snapshot 返回防御性拷贝：修改返回值不影响内部状态", () => {
    registry.update("feishu", { kind: "feishu", state: { kind: "running", since: 1000 } });
    const snap = registry.snapshot();
    (snap[0] as any).channelId = "hacked";
    expect(registry.snapshot()[0].channelId).toBe("feishu");
  });

  it("token_stale 状态写入与读取", () => {
    registry.update("weixin-acc1", { kind: "weixin", state: { kind: "token_stale", since: 3000, errmsg: "session timeout" } });
    const snap = registry.snapshot();
    expect(snap[0].state).toMatchObject({ kind: "token_stale", errmsg: "session timeout" });
  });

  it("stopped 状态支持 not_started reason", () => {
    registry.update("weixin-acc1", { kind: "weixin", state: { kind: "stopped", since: 4000, reason: "not_started" } });
    const snap = registry.snapshot();
    expect(snap[0].state).toMatchObject({ kind: "stopped", reason: "not_started" });
  });
});
