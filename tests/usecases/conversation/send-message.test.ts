/**
 * SendMessage 单元测试（真 sqlite）。
 *
 * 消息状态机 + 显式目标校验（F20260728htar）+ 默认派发解析（F20260724dsp，事故史逻辑）。
 * 从 65 方法手写 mock 转换为真仓库：mock 手写镜像是 fake green 温床（F20260805rsto 教训），
 * 转换后种子与断言走与生产相同的 SQL 路径。
 * MemoryIndexGateway 保留 stub（记忆索引是旁路端口，其真实行为由 store-memory 测试与能力层覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { SendMessage } from "@usecases/conversation/send-message";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { Conversation, Turn, ConversationParticipant } from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
import type { Otter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

function otterFixture(overrides: Partial<Otter> = {}): Otter {
  return {
    id: "otter-big", name: "大獭", type: "big", status: "active",
    role: null, parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
    ...overrides,
  };
}

function messageFixture(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
    senderType: "otter", senderId: "otter-big", talkingStonePassedTo: ["user"],
    status: "completed", body: "发言", sequenceNum: 1,
    contextTokens: null, contextTokensMax: null, source: "web",
    createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// eslint-disable-next-line max-lines-per-function -- 状态机全覆盖用例集，单 describe 聚合
describe("SendMessage（真 sqlite）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  let indexed: Array<{ messageId: string; content: string }>;
  let sm: SendMessage;
  let turnSeq: number;

  /** 记忆索引 stub：只捕获调用，不断言其内部（那是 store-memory 测试的职责） */
  function stubMemoryIndex(): MemoryIndexGateway {
    return {
      indexMessage: vi.fn(async (messageId: string, _convId: string, content: string) => {
        indexed.push({ messageId, content });
      }),
      indexLinkedResource: vi.fn(),
      indexFeature: vi.fn(),
      indexResearch: vi.fn(),
      indexFeatureChunks: vi.fn(),
      indexResearchChunks: vi.fn(),
    };
  }

  async function seedOtter(o: Otter): Promise<void> {
    await otterRepo.createOtter(o);
  }

  async function joinParticipant(otterId: string, opts: { status?: "active" | "left" } = {}): Promise<void> {
    const p: ConversationParticipant = {
      id: `p-${otterId}`, conversationId: "conv-1", otterId,
      joinedAtTurnId: null, joinedAtTurnNumber: 0,
      leftAtTurnId: opts.status === "left" ? "turn-1" : null,
      leftAtTurnNumber: opts.status === "left" ? 1 : null,
      status: opts.status ?? "active",
      createdAt: "2026-01-01T00:00:00Z",
      leftAt: opts.status === "left" ? "2026-01-01T01:00:00Z" : null,
      lastReadTurnNumber: 0,
    };
    await repo.createParticipant(p);
  }

  async function newTurn(): Promise<string> {
    turnSeq += 1;
    const id = `turn-${turnSeq}`;
    const turn: Turn = {
      id, conversationId: "conv-1", turnNumber: turnSeq, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await repo.createTurn(turn);
    return id;
  }

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);
    indexed = [];
    turnSeq = 0;

    const conv: Conversation = {
      id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    await repo.create(conv);
    await newTurn();

    sm = new SendMessage(repo, otterRepo, stubMemoryIndex(), createTestLogger());
  });

  afterEach(() => {
    db.close();
  });

  describe("send", () => {
    it("创建已完成消息，返回 status=completed", async () => {
      await seedOtter(otterFixture());
      await joinParticipant("otter-big");

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "你好", talkingStonePassedTo: [] });

      expect(msg.status).toBe("completed");
      const stored = await repo.getMessageById(msg.id);
      expect(stored!.status).toBe("completed");
      expect(stored!.body).toBe("你好");
      expect(stored!.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("记忆索引写入 html-card 剥离投影（卡片源码不入索引）", async () => {
      await seedOtter(otterFixture());
      await joinParticipant("otter-big");

      const msg = await sm.send({
        conversationId: "conv-1", senderId: "user-1",
        body: '前文\n```html-card\n{"card":"源码"}\n```\n后文',
        talkingStonePassedTo: [],
      });

      const record = indexed.find((r) => r.messageId === msg.id);
      expect(record).toBeTruthy();
      /** 投影语义（F20260804hcob 等）：fence 源码剥离、替换为 [html-card: 标题] 占位。
       *  关键不变量：卡片源码不入索引 */
      expect(record!.content).not.toContain("源码");
      expect(record!.content).not.toContain("```");
      expect(record!.content).toContain("前文");
      expect(record!.content).toContain("后文");
    });
  });

  describe("显式目标校验（F20260728htar：在场 + otter 未解散）", () => {
    it("显式目标在场且 active：原样保留", async () => {
      await seedOtter(otterFixture());
      await joinParticipant("otter-big");

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "@大獭 你好", talkingStonePassedTo: ["otter-big"] });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("显式目标已解散：全部不合法退默认派发（已解散者不被复活）", async () => {
      await seedOtter(otterFixture({ id: "otter-dead", name: "死獭", status: "dissolved", dissolvedAt: "2026-01-01T02:00:00Z" }));
      await seedOtter(otterFixture());
      await joinParticipant("otter-dead");
      await joinParticipant("otter-big");

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "@死獭 你好", talkingStonePassedTo: ["otter-dead"] });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("显式目标不在场（无参与记录）：退默认派发", async () => {
      await seedOtter(otterFixture({ id: "otter-outsider", name: "局外獭" }));
      await seedOtter(otterFixture());
      await joinParticipant("otter-big");

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "@局外獭", talkingStonePassedTo: ["otter-outsider"] });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("部分目标不合法：过滤后保留合法目标，不退默认派发", async () => {
      await seedOtter(otterFixture({ id: "otter-small", name: "小獭", type: "small" }));
      await seedOtter(otterFixture({ id: "otter-dead", name: "死獭", status: "dissolved", dissolvedAt: "2026-01-01T02:00:00Z" }));
      await joinParticipant("otter-small");
      await joinParticipant("otter-dead");

      const msg = await sm.send({
        conversationId: "conv-1", senderId: "user-1", body: "@小獭 @死獭",
        talkingStonePassedTo: ["otter-small", "otter-dead"],
      });

      expect(msg.talkingStonePassedTo).toEqual(["otter-small"]);
    });

    it("system 消息豁免校验：显式目标不在场也原样保留（定时任务链不改派）", async () => {
      const msg = await sm.send({
        conversationId: "conv-1", senderType: "system", senderId: "system",
        body: "定时提醒", talkingStonePassedTo: ["otter-nonexistent"],
      });

      expect(msg.talkingStonePassedTo).toEqual(["otter-nonexistent"]);
    });
  });

  describe("默认目标解析（无 @）", () => {
    it("优先最后发言的在场 otter", async () => {
      await seedOtter(otterFixture());
      await seedOtter(otterFixture({ id: "otter-small", name: "小獭", type: "small" }));
      await joinParticipant("otter-big");
      await joinParticipant("otter-small");
      await repo.createCompletedMessage(messageFixture({ id: "msg-spoke", senderId: "otter-small", sequenceNum: 9 }));

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "继续", talkingStonePassedTo: [] });

      expect(msg.talkingStonePassedTo).toEqual(["otter-small"]);
    });

    it("最后发言的 otter 消息为 failed 也算发言", async () => {
      await seedOtter(otterFixture());
      await seedOtter(otterFixture({ id: "otter-small", name: "小獭", type: "small" }));
      await joinParticipant("otter-big");
      await joinParticipant("otter-small");
      await repo.createCompletedMessage(messageFixture({ id: "msg-failed", senderId: "otter-small", status: "failed", sequenceNum: 9 }));

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "继续", talkingStonePassedTo: [] });

      expect(msg.talkingStonePassedTo).toEqual(["otter-small"]);
    });

    it("最后发言者在场但已解散则兜底大獭", async () => {
      await seedOtter(otterFixture());
      await seedOtter(otterFixture({ id: "otter-small", name: "小獭", type: "small", status: "dissolved", dissolvedAt: "2026-01-01T02:00:00Z" }));
      await joinParticipant("otter-big");
      await joinParticipant("otter-small");
      await repo.createCompletedMessage(messageFixture({ id: "msg-spoke", senderId: "otter-small", sequenceNum: 9 }));

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "继续", talkingStonePassedTo: [] });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("最后发言者已退场则兜底大獭", async () => {
      await seedOtter(otterFixture());
      await seedOtter(otterFixture({ id: "otter-small", name: "小獭", type: "small" }));
      await joinParticipant("otter-big");
      await joinParticipant("otter-small", { status: "left" });
      await repo.createCompletedMessage(messageFixture({ id: "msg-spoke", senderId: "otter-small", sequenceNum: 9 }));

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "继续", talkingStonePassedTo: [] });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("无 otter 发言过时兜底大獭", async () => {
      await seedOtter(otterFixture());
      await joinParticipant("otter-big");

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "你好", talkingStonePassedTo: [] });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("无法解析（无最后发言者、无大獭）抛出 validation 错误", async () => {
      await seedOtter(otterFixture({ id: "otter-small", name: "小獭", type: "small" }));
      await joinParticipant("otter-small");

      await expect(
        sm.send({ conversationId: "conv-1", senderId: "user-1", body: "你好", talkingStonePassedTo: [] }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });
  });

  describe("send（system 与 Turn）", () => {
    it("system 消息空 talkingStonePassedTo 可成功", async () => {
      const msg = await sm.send({ conversationId: "conv-1", senderType: "system", senderId: "system", body: "系统通知", talkingStonePassedTo: [] });

      expect(msg.status).toBe("completed");
      expect(msg.senderType).toBe("system");
    });

    it("无活跃 Turn 时自动创建新 Turn（turn-per-hop：用户消息终态后该 Turn 随即关闭）", async () => {
      await repo.closeTurn("turn-1", "2026-01-01T01:00:00Z");
      await seedOtter(otterFixture());
      await joinParticipant("otter-big");

      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "新回合", talkingStonePassedTo: [] });

      /** 真实语义：消息落在新建 Turn（非 turn-1）；该 Turn 因用户消息已终态被 tryCloseTurn 关闭——
       *  turn 是"一跳"而非"一轮问答"（后续 otter 发言会开下一个 Turn） */
      expect(msg.turnId).not.toBe("turn-1");
      const msgTurn = await repo.getTurnById(msg.turnId);
      expect(msgTurn).not.toBeNull();
      expect(msgTurn!.closedAt).not.toBeNull();
    });
  });

  describe("start / appendEvent / complete / fail / abort（流式生命周期）", () => {
    it("start 创建流式消息，status=streaming，body=null", async () => {
      const msg = await sm.start({ conversationId: "conv-1", senderId: "otter-big", talkingStonePassedTo: ["user"] });

      expect(msg.status).toBe("streaming");
      expect(msg.body).toBeNull();
      const stored = await repo.getMessageById(msg.id);
      expect(stored!.status).toBe("streaming");
    });

    it("streaming 消息可追加事件", async () => {
      const msg = await sm.start({ conversationId: "conv-1", senderId: "otter-big", talkingStonePassedTo: ["user"] });

      await sm.appendEvent({ messageId: msg.id, eventType: "assistant_text", payload: { text: "片段" } });

      const events = await repo.getMessageEvents(msg.id);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("assistant_text");
    });

    it("completed 消息追加事件抛出 validation 错误", async () => {
      await seedOtter(otterFixture());
      await joinParticipant("otter-big");
      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "完成", talkingStonePassedTo: [] });

      await expect(
        sm.appendEvent({ messageId: msg.id, eventType: "assistant_text", payload: {} }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });

    it("消息不存在时追加事件抛出 not_found 错误", async () => {
      await expect(
        sm.appendEvent({ messageId: "ghost", eventType: "assistant_text", payload: {} }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "not_found");
    });

    it("complete：speaking -> completed 并设置 body", async () => {
      const msg = await sm.start({ conversationId: "conv-1", senderId: "otter-big", talkingStonePassedTo: ["user"] });
      await sm.startSpeaking(msg.id, { body: "发言内容", talkingStonePassedTo: ["user"] });

      await sm.complete(msg.id, { body: "发言内容", talkingStonePassedTo: ["user"] });

      const stored = await repo.getMessageById(msg.id);
      expect(stored!.status).toBe("completed");
      expect(stored!.body).toBe("发言内容");
    });

    it("complete：空 body 抛出 validation 错误", async () => {
      const msg = await sm.start({ conversationId: "conv-1", senderId: "otter-big", talkingStonePassedTo: ["user"] });

      await expect(sm.complete(msg.id, { body: "" })).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });

    it("fail：streaming 消息可标记失败", async () => {
      const msg = await sm.start({ conversationId: "conv-1", senderId: "otter-big", talkingStonePassedTo: ["user"] });

      await sm.fail(msg.id, "失败原因");

      expect((await repo.getMessageById(msg.id))!.status).toBe("failed");
    });

    it("fail：completed 消息标记失败抛出 validation 错误", async () => {
      await seedOtter(otterFixture());
      await joinParticipant("otter-big");
      const msg = await sm.send({ conversationId: "conv-1", senderId: "user-1", body: "完成", talkingStonePassedTo: [] });

      await expect(sm.fail(msg.id)).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });

    it("abort：streaming -> aborted 并设置 body", async () => {
      const msg = await sm.start({ conversationId: "conv-1", senderId: "otter-big", talkingStonePassedTo: ["user"] });

      await sm.abort(msg.id, { body: "被中断", talkingStonePassedTo: ["user"] });

      const stored = await repo.getMessageById(msg.id);
      expect(stored!.status).toBe("aborted");
      expect(stored!.body).toBe("被中断");
    });
  });

  describe("sendSystem", () => {
    it("创建已完成的系统消息，talkingStonePassedTo 为空数组", async () => {
      const msg = await sm.sendSystem("conv-1", "系统广播");

      expect(msg.status).toBe("completed");
      expect(msg.senderType).toBe("system");
      expect(msg.talkingStonePassedTo).toEqual([]);
      expect((await repo.getMessageById(msg.id))!.body).toBe("系统广播");
    });
  });
});
