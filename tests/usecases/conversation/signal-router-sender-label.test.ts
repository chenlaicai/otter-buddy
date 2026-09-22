import { describe, it, expect } from "vitest";
import { resolveSignalSenderLabel } from "@usecases/conversation/signal-router";

describe("resolveSignalSenderLabel（F20260922ctxi 发送者显示名回退链）", () => {
  it("有快照名时优先用快照名（飞书群聊多人识别）", () => {
    expect(resolveSignalSenderLabel("张三", "ou_zhangsan", "chen")).toBe("张三");
  });

  it("快照名缺失时回退配置显示名（#488 同款降级）——修 [user] 标签瑕疵", () => {
    expect(resolveSignalSenderLabel(undefined, "user", "chen")).toBe("chen");
    expect(resolveSignalSenderLabel("", "user", "chen")).toBe("chen");
    expect(resolveSignalSenderLabel("   ", "user", "chen")).toBe("chen");
  });

  it("快照名与配置名都缺失时回退 senderId（旧行为兜底）", () => {
    expect(resolveSignalSenderLabel(undefined, "user", undefined)).toBe("user");
    expect(resolveSignalSenderLabel(undefined, "ou_lisi", "")).toBe("ou_lisi");
  });

  it("访客有快照名时不被配置名覆盖（不冒名搭档）", () => {
    expect(resolveSignalSenderLabel("访客甲", "ou_guest", "chen")).toBe("访客甲");
  });
});
