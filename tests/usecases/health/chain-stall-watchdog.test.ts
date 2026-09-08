/**
 * 编排链滞留看门狗测试（#822）
 *
 * A 类：输入输出确定数据，正确性由代码决定。
 * 四种场景覆盖（验收标准）：
 * AT-1 滞留触发：中断型消息 + 超阈值 → 告警
 * AT-2 有进展不触发：尾部是 user/otter 活跃消息 → 无告警
 * AT-3 终态不触发：中断型消息 + 未超阈值 → 无告警
 * AT-4 重启残留排除：自动恢复型消息 → classifyInterruption 返回 null
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyInterruption,
  detectChainStallFromRows,
  buildStallAlertBody,
  ChainStallWatchdogWorker,
  CHAIN_STALL_WATCHDOG_SIGNAL_TYPE,
} from "@usecases/health/chain-stall-watchdog";
import type { TailRow } from "@usecases/health/chain-stall-watchdog";
import { SignalRepository } from "@usecases/health/signal-repository";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import type Database from "better-sqlite3";

// ── helpers ──────────────────────────────────────────────────────────────────

/** 往测试 DB 里插入一条会话 + 尾部消息（turn + message + segment） */
function insertTailRow(
  db: Database.Database,
  opts: {
    conversationId: string;
    messageId: string;
    senderType: "user" | "otter" | "system";
    senderId: string;
    body: string;
    createdAt: string;
    status?: string;
    sequenceNum?: number;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`,
  ).run(opts.conversationId, `test-${opts.conversationId}`, now, now);
  const turnId = `turn-${opts.messageId}`;
  db.prepare(
    `INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, status, created_at) VALUES (?, ?, 1, 'open', ?)`,
  ).run(turnId, opts.conversationId, now);
  db.prepare(
    `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.messageId, opts.conversationId, opts.senderType, opts.senderId,
    opts.status ?? "completed", opts.sequenceNum ?? 1, turnId, opts.createdAt,
  );
  db.prepare(
    `INSERT INTO message_segments (id, message_id, body, sequence_num) VALUES (?, ?, ?, 1)`,
  ).run(`seg-${opts.messageId}`, opts.messageId, opts.body);
}

// ── 纯函数测试 ──────────────────────────────────────────────────────────────

describe("classifyInterruption", () => {
  it("AT-4: 自动继续执行中 → null（熔断重启路径，非悬置）", () => {
    expect(classifyInterruption("[系统保护] 检测到连续输出退化，已重启獭生（清空污染上下文），自动继续执行中。")).toBeNull();
  });

  it("AT-4: [搭档中断] → null（设计内行为）", () => {
    expect(classifyInterruption("[搭档中断] 用户手动停止。")).toBeNull();
  });

  it("AT-4: 请手动重试 → null（已有明确人工指引）", () => {
    expect(classifyInterruption("[系统保护] 输出异常，已自动中断。请手动重试")).toBeNull();
  });

  it("AT-1: 熔断超限终态 → 判定中断（返回非空）", () => {
    const result = classifyInterruption("[系统保护] 该獭连续输出退化且已达熔断上限，发言已中断。如需恢复请重启该獭。");
    expect(result).toBeTruthy();
    expect(result).toContain("熔断上限");
  });

  it("AT-1: 工具调用超时 → 判定中断", () => {
    const result = classifyInterruption("[系统保护] 单次工具调用超时，已自动中断。");
    expect(result).toBeTruthy();
    expect(result).toContain("工具调用超时");
  });

  it("AT-1: 服务重启中断 → 判定中断", () => {
    const result = classifyInterruption("[服务重启，发言中断]");
    // stripped 为空 → fallback 返回原文（含括号）
    expect(result).toBeTruthy();
    expect(result).toContain("服务重启");
  });

  it("普通系统消息（非中断型）→ null", () => {
    expect(classifyInterruption("[链滞留告警] 链 abc12345 已滞留 60 分钟")).toBeNull();
  });
});

describe("detectChainStallFromRows", () => {
  const now = new Date("2026-09-08T10:00:00Z");

  it("AT-1: 滞留触发——中断型消息 + 超阈值 → 告警", () => {
    const rows: TailRow[] = [{
      conversationId: "conv-1",
      messageId: "msg-1",
      senderType: "system",
      senderId: "system",
      status: "completed",
      createdAt: "2026-09-08T09:00:00Z", // 1h 前
      body: "[系统保护] 单次工具调用超时，已自动中断。",
    }];
    const alerts = detectChainStallFromRows(rows, now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.conversationId).toBe("conv-1");
    expect(alerts[0]!.stalledMinutes).toBe(60);
    expect(alerts[0]!.interruptionKind).toContain("工具调用超时");
  });

  it("AT-2: 有进展不触发——尾部是 user 活跃消息", () => {
    const rows: TailRow[] = [{
      conversationId: "conv-2",
      messageId: "msg-2",
      senderType: "user",
      senderId: "chen",
      status: "completed",
      createdAt: "2026-09-08T09:00:00Z",
      body: "帮我看看这个问题",
    }];
    const alerts = detectChainStallFromRows(rows, now);
    expect(alerts).toHaveLength(0);
  });

  it("AT-2: 有进展不触发——尾部是 otter 活跃消息", () => {
    const rows: TailRow[] = [{
      conversationId: "conv-3",
      messageId: "msg-3",
      senderType: "otter",
      senderId: "otter-abc",
      status: "completed",
      createdAt: "2026-09-08T09:00:00Z",
      body: "我来看看代码结构",
    }];
    const alerts = detectChainStallFromRows(rows, now);
    expect(alerts).toHaveLength(0);
  });

  it("AT-3: 终态不触发——中断型消息但未超阈值", () => {
    const rows: TailRow[] = [{
      conversationId: "conv-4",
      messageId: "msg-4",
      senderType: "system",
      senderId: "system",
      status: "completed",
      createdAt: "2026-09-08T09:45:00Z", // 15min 前 < 30min 阈值
      body: "[系统保护] 生成过程超时，已自动中断。",
    }];
    const alerts = detectChainStallFromRows(rows, now);
    expect(alerts).toHaveLength(0);
  });

  it("AT-4: 重启残留排除——自动恢复消息不告警", () => {
    const rows: TailRow[] = [{
      conversationId: "conv-5",
      messageId: "msg-5",
      senderType: "system",
      senderId: "system",
      status: "completed",
      createdAt: "2026-09-08T08:00:00Z", // 2h 前，超阈值
      body: "[系统保护] 检测到连续输出退化，已重启獭生（清空污染上下文），自动继续执行中。",
    }];
    const alerts = detectChainStallFromRows(rows, now);
    expect(alerts).toHaveLength(0);
  });

  it("AT-1: 熔断超限终态消息 → 告警", () => {
    const rows: TailRow[] = [{
      conversationId: "conv-6",
      messageId: "msg-6",
      senderType: "system",
      senderId: "system",
      status: "completed",
      createdAt: "2026-09-08T08:30:00Z", // 1.5h 前
      body: "[系统保护] 该獭连续输出退化且已达熔断上限，发言已中断。如需恢复请重启该獭。",
    }];
    const alerts = detectChainStallFromRows(rows, now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.interruptionKind).toContain("熔断上限");
  });

  it("AT-1: failMessage 拼接场景（半截内容 + 中断声明在末段）→ 告警", () => {
    const rows: TailRow[] = [{
      conversationId: "conv-7",
      messageId: "msg-7",
      senderType: "otter",
      senderId: "otter-abc",
      status: "completed",
      createdAt: "2026-09-08T07:00:00Z", // 3h 前
      body: "让我先读一下这个文件的内容，然后分...[系统保护] 输出异常，已自动中断。",
    }];
    const alerts = detectChainStallFromRows(rows, now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.otterId).toBe("otter-abc");
  });

  it("空行集 → 零告警", () => {
    expect(detectChainStallFromRows([], now)).toHaveLength(0);
  });
});

describe("buildStallAlertBody", () => {
  it("生成告警文案包含关键字段", () => {
    const body = buildStallAlertBody({
      conversationId: "conv-12345678-abcd",
      messageId: "msg-1",
      otterId: "otter-abc",
      stalledMinutes: 65,
      interruptionKind: "工具调用超时",
      lastActionSummary: "正在读取 config.json",
    }, "conv-1234");
    expect(body).toContain("[链滞留告警]");
    expect(body).toContain("conv-1234");
    expect(body).toContain("65 分钟");
    expect(body).toContain("工具调用超时");
    expect(body).toContain("#822 看门狗");
  });
});

// ── Worker 集成测试（DB 真库）─────────────────────────────────────────────────

describe("ChainStallWatchdogWorker.scanOnce", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createWorker(opts?: { now?: Date; thresholdMs?: number }) {
    const signalRepo = new SignalRepository(db);
    const sentMessages: Array<{ conversationId: string; body: string }> = [];
    const sendSystem = async (conversationId: string, body: string) => {
      sentMessages.push({ conversationId, body });
      return { id: `sys-${Date.now()}`, body, sequenceNum: 999 };
    };
    const worker = new ChainStallWatchdogWorker(db, signalRepo, sendSystem, createTestLogger(), {
      now: opts?.now ? () => opts.now! : undefined,
      thresholdMs: opts?.thresholdMs,
    });
    return { worker, signalRepo, sentMessages };
  }

  it("AT-1: 滞留会话 → sendSystem 告警 + RHI critical 信号", async () => {
    const now = new Date("2026-09-08T10:00:00Z");
    insertTailRow(db, {
      conversationId: "conv-stall-1",
      messageId: "msg-stall-1",
      senderType: "system",
      senderId: "system",
      body: "[系统保护] 单次工具调用超时，已自动中断。",
      createdAt: "2026-09-08T09:00:00Z",
    });

    const { worker, signalRepo, sentMessages } = createWorker({ now });
    const result = await worker.scanOnce();

    expect(result.alerts).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.conversationId).toBe("conv-stall-1");
    expect(sentMessages[0]!.body).toContain("[链滞留告警]");

    const open = signalRepo.findOpen().filter(s => s.signal_type === CHAIN_STALL_WATCHDOG_SIGNAL_TYPE);
    expect(open).toHaveLength(1);
    expect(open[0]!.severity).toBe("critical");
    expect(open[0]!.feature_id).toBe("conv-stall-1");

    await worker.stop();
  });

  it("AT-2: 有进展会话 → 零告警零信号", async () => {
    const now = new Date("2026-09-08T10:00:00Z");
    insertTailRow(db, {
      conversationId: "conv-active-1",
      messageId: "msg-active-1",
      senderType: "user",
      senderId: "chen",
      body: "继续",
      createdAt: "2026-09-08T09:00:00Z",
    });

    const { worker, signalRepo, sentMessages } = createWorker({ now });
    const result = await worker.scanOnce();

    expect(result.alerts).toBe(0);
    expect(sentMessages).toHaveLength(0);
    const open = signalRepo.findOpen().filter(s => s.signal_type === CHAIN_STALL_WATCHDOG_SIGNAL_TYPE);
    expect(open).toHaveLength(0);

    await worker.stop();
  });

  it("AT-3: 未超阈值 → 零告警", async () => {
    const now = new Date("2026-09-08T10:00:00Z");
    insertTailRow(db, {
      conversationId: "conv-recent-1",
      messageId: "msg-recent-1",
      senderType: "system",
      senderId: "system",
      body: "[系统保护] 生成过程超时，已自动中断。",
      createdAt: "2026-09-08T09:45:00Z",
    });

    const { worker, sentMessages } = createWorker({ now });
    const result = await worker.scanOnce();

    expect(result.alerts).toBe(0);
    expect(sentMessages).toHaveLength(0);

    await worker.stop();
  });

  it("AT-4: 熔断重启残留 → 不告警（自动恢复路径）", async () => {
    const now = new Date("2026-09-08T10:00:00Z");
    insertTailRow(db, {
      conversationId: "conv-restart-1",
      messageId: "msg-restart-1",
      senderType: "system",
      senderId: "system",
      body: "[系统保护] 检测到连续输出退化，已重启獭生（清空污染上下文），自动继续执行中。",
      createdAt: "2026-09-08T08:00:00Z",
    });

    const { worker, sentMessages } = createWorker({ now });
    const result = await worker.scanOnce();

    expect(result.alerts).toBe(0);
    expect(sentMessages).toHaveLength(0);

    await worker.stop();
  });

  it("信号 reconcile：告警消失后自动 resolve", async () => {
    const now = new Date("2026-09-08T10:00:00Z");
    insertTailRow(db, {
      conversationId: "conv-reconcile-1",
      messageId: "msg-reconcile-1",
      senderType: "system",
      senderId: "system",
      body: "[系统保护] 输出异常，已自动中断。",
      createdAt: "2026-09-08T09:00:00Z",
    });

    const { worker, signalRepo } = createWorker({ now });
    await worker.scanOnce();

    const openBefore = signalRepo.findOpen().filter(s => s.signal_type === CHAIN_STALL_WATCHDOG_SIGNAL_TYPE);
    expect(openBefore).toHaveLength(1);

    // 第二轮：会话消失 → 信号 resolve
    // Why：先删 segments（CASCADE）再删 messages 最后删 conversation，规避 FK 约束
    db.prepare("DELETE FROM message_segments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)").run("conv-reconcile-1");
    db.prepare("DELETE FROM message_events WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)").run("conv-reconcile-1");
    db.prepare("DELETE FROM dispatch_attempts WHERE conversation_id = ?").run("conv-reconcile-1");
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run("conv-reconcile-1");
    db.prepare("DELETE FROM turns WHERE conversation_id = ?").run("conv-reconcile-1");
    db.prepare("DELETE FROM conversations WHERE id = ?").run("conv-reconcile-1");

    await worker.scanOnce();

    const openAfter = signalRepo.findOpen().filter(s => s.signal_type === CHAIN_STALL_WATCHDOG_SIGNAL_TYPE);
    expect(openAfter).toHaveLength(0);

    await worker.stop();
  });
});
