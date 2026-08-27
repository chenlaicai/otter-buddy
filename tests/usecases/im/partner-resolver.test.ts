import { describe, it, expect } from "vitest";
import { PartnerResolver } from "@usecases/im/partner-resolver";

describe("PartnerResolver（F20260826fpbd）", () => {
  it("已配置：open_id 匹配 → 搭档", () => {
    const r = new PartnerResolver("ou_partner");
    expect(r.configured).toBe(true);
    expect(r.isPartner("ou_partner")).toBe(true);
  });

  it("已配置：open_id 不匹配 → 非搭档（访客）", () => {
    const r = new PartnerResolver("ou_partner");
    expect(r.isPartner("ou_joy")).toBe(false);
  });

  it("Web 端 senderId='user' 恒为搭档（本机即搭档本人），即使未配置", () => {
    const configured = new PartnerResolver("ou_partner");
    const unconfigured = new PartnerResolver(undefined);
    expect(configured.isPartner("user")).toBe(true);
    expect(unconfigured.isPartner("user")).toBe(true);
  });

  it("未配置：configured=false，飞书 senderId 均非搭档（消费方走降级路径）", () => {
    const r = new PartnerResolver(undefined);
    expect(r.configured).toBe(false);
    expect(r.isPartner("ou_partner")).toBe(false);
    expect(r.isPartner("ou_anyone")).toBe(false);
  });

  it("空串视为未配置（yaml 留空不生效）", () => {
    const r = new PartnerResolver("   ");
    expect(r.configured).toBe(false);
  });
});
