import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { FeishuMessageChannel } from "@usecases/im/feishu-message-channel";
import { PartnerResolver } from "@usecases/im/partner-resolver";
import { botKey } from "@frameworks/feishu/bot-key";
import type { SSEEvent } from "@contract/sse/events";

/**
 * F20260928fsqr：多 app 键控出站隔离（#591 同构）+ PartnerResolver.addPartnerId 运行时写入。
 *
 * 场景：两个扫码 app（A/B）各注册一条出站通道（key=botKey）；A 线的会话事件
 * 只能被 A 通道投递——B 通道的 client 打 A 的会话会被飞书 API 拒（bot 不在会话里），
 * 且双通道广播是 #591 修过的重复投递面。
 */

function userEntryEvent(): SSEEvent {
  return {
    event: "entry.user",
    data: {
      entryId: "entry-1", sequenceNum: 1, senderId: "user",
      body: "hello", createdAt: new Date().toISOString(),
      yieldTargets: undefined, source: "web",
    },
  } as never;
}

function makeChannel(botKeyValue: string | undefined) {
  const manageConnection = {
    getSessionByConversation: vi.fn().mockResolvedValue(null),
    getConnection: vi.fn().mockResolvedValue(null),
    resolveReplyTarget: vi.fn((conn: { externalId: string }) => conn.externalId),
  } as any;
  const gateway = { replyText: vi.fn(), replyMarkdown: vi.fn() } as any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const channel = new FeishuMessageChannel({ manageConnection, feishuGateway: gateway, logger, botKey: botKeyValue });
  return { channel, manageConnection, gateway };
}

describe("F20260928fsqr：多 app 出站键控隔离", () => {
  it("A 线事件只进 A 通道（externalId===botKey），B 通道不投", async () => {
    const keyA = botKey("cli_appAAA111");
    const keyB = botKey("cli_appBBB222");
    const a = makeChannel(keyA);
    const b = makeChannel(keyB);
    const broadcaster = new MessageBroadcaster({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any);
    broadcaster.registerOutboundChannel(keyA, a.channel);
    broadcaster.registerOutboundChannel(keyB, b.channel);

    // A 线会话绑定（externalId = A 的 botKey）
    a.manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-A" });
    a.manageConnection.getConnection.mockResolvedValue({ externalId: keyA, externalType: "feishu" });
    b.manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-A" });
    b.manageConnection.getConnection.mockResolvedValue({ externalId: keyA, externalType: "feishu" });

    broadcaster.broadcastEvent("conv-A", userEntryEvent());

    // onEvent fire-and-forget：异步链路用 waitFor
    await vi.waitFor(() => expect(a.gateway.replyMarkdown).toHaveBeenCalled());
    expect(b.gateway.replyMarkdown).not.toHaveBeenCalled(); // B 通道对 A 线静默跳过
  });

  it("botKey 未注入（存量单 app 零参构造）→ 仅类型过滤，行为不变", async () => {
    const { channel, manageConnection, gateway } = makeChannel(undefined);
    manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-x" });
    // 存量线 externalId 可以是任意值（含掩码 bot 键或旧 chatId）
    manageConnection.getConnection.mockResolvedValue({ externalId: "feishu-bot:cli_a****z9k2", externalType: "feishu" });

    channel.onEvent("conv-x", userEntryEvent());
    // onEvent fire-and-forget：异步链路用 waitFor（到达 replyTarget 解析即视为通过归属判定）
    await vi.waitFor(() => expect(manageConnection.resolveReplyTarget).toHaveBeenCalled());
    expect(gateway.replyText).not.toHaveBeenCalled(); // user 事件走 replyText 入口前有 source 防回环闸
  });

  it("非飞书连接（externalType=weixin）→ 两条通道都不投", async () => {
    const keyA = botKey("cli_appAAA111");
    const a = makeChannel(keyA);
    a.manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-wx" });
    a.manageConnection.getConnection.mockResolvedValue({ externalId: "weixin-bot:x", externalType: "weixin" });

    const broadcaster = new MessageBroadcaster({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any);
    broadcaster.registerOutboundChannel(keyA, a.channel);
    broadcaster.broadcastEvent("conv-wx", userEntryEvent());
    expect(a.gateway.replyText).not.toHaveBeenCalled();
  });
});

describe("F20260928fsqr：PartnerResolver.addPartnerId 运行时写入", () => {
  it("扫码首号运行时写入 → configured 动态翻真 + isPartner 命中", () => {
    const r = new PartnerResolver(); // 纯扫码主路径：构造期无锚
    expect(r.configured).toBe(false);
    r.addPartnerId("ou_first_owner");
    expect(r.configured).toBe(true); // getter 动态反映（非构造期快照）
    expect(r.isPartner("ou_first_owner")).toBe(true);
  });

  it("幂等 + 空白串忽略", () => {
    const r = new PartnerResolver();
    r.addPartnerId("ou_x");
    r.addPartnerId("ou_x");
    r.addPartnerId("   ");
    r.addPartnerId(undefined);
    expect(r.isPartner("ou_x")).toBe(true);
    expect(r.isPartner("ou_y")).toBe(false);
  });

  it("构造期锚（config 双渠道）与运行时写入共存", () => {
    const r = new PartnerResolver("ou_config", "wxid_1");
    r.addPartnerId("ou_scan_later");
    expect(r.isPartner("ou_config")).toBe(true);
    expect(r.isPartner("wxid_1")).toBe(true);
    expect(r.isPartner("ou_scan_later")).toBe(true);
    expect(r.isPartner("ou_stranger")).toBe(false);
  });
});
