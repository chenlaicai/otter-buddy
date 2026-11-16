import { describe, it, expect } from "vitest";
import { PartnerResolver } from "@usecases/im/partner-resolver";

describe("PartnerResolver（F20260826fpbd）", () => {
  it("已配置：open_id 匹配 → 搭档", () => {
    const r = PartnerResolver.forGate("ou_partner");
    expect(r.configured).toBe(true);
    expect(r.isPartner("ou_partner")).toBe(true);
  });

  it("已配置：open_id 不匹配 → 非搭档（访客）", () => {
    const r = PartnerResolver.forGate("ou_partner");
    expect(r.isPartner("ou_joy")).toBe(false);
  });

  it("Web 端 senderId='user' 恒为搭档（本机即搭档本人），即使未配置", () => {
    const configured = PartnerResolver.forGate("ou_partner");
    const unconfigured = PartnerResolver.forGate(undefined);
    expect(configured.isPartner("user")).toBe(true);
    expect(unconfigured.isPartner("user")).toBe(true);
  });

  it("未配置：configured=false，飞书 senderId 均非搭档（消费方走降级路径）", () => {
    const r = PartnerResolver.forGate(undefined);
    expect(r.configured).toBe(false);
    expect(r.isPartner("ou_partner")).toBe(false);
    expect(r.isPartner("ou_anyone")).toBe(false);
  });

  it("空串视为未配置（yaml 留空不生效）", () => {
    const r = PartnerResolver.forGate("   ");
    expect(r.configured).toBe(false);
  });

  // F20260928wxid：多渠道——同一搭档在飞书是 open_id、微信是 ilink_user_id
  it("F20260928wxid：双渠道 ID——任一匹配即搭档（微信消息也能被认出是本人）", () => {
    const r = PartnerResolver.forIdentity("ou_partner", "wxid_partner@im.wechat");
    expect(r.configured).toBe(true);
    expect(r.isPartner("ou_partner")).toBe(true);
    expect(r.isPartner("wxid_partner@im.wechat")).toBe(true);
    expect(r.isPartner("ou_joy")).toBe(false);
    expect(r.isPartner("wxid_joy@im.wechat")).toBe(false);
  });

  it("F20261113wxplo：forGate 单渠道锚——跨渠道 ID 不命中（门禁不受另一渠道污染）", () => {
    const r = PartnerResolver.forGate("ou_partner");
    expect(r.configured).toBe(true);
    expect(r.isPartner("wxid_partner@im.wechat")).toBe(false);
  });

  it("F20260928wxid：空白串过滤——仅第二参为空白时 configured=false", () => {
    const r = PartnerResolver.forGate(undefined, "   ");
    expect(r.configured).toBe(false);
  });

  it("F20260928wxid：senderId 前后空白容错（与单参时代 trim 语义一致）", () => {
    const r = PartnerResolver.forIdentity("ou_partner", "wxid_partner@im.wechat");
    expect(r.isPartner(" ou_partner ")).toBe(true);
  });
});
