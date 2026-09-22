import { describe, it, expect, vi } from "vitest";

/**
 * #763：toolCallCount 快照竞态修复——驱动真实 catch 分支的回归锁。
 *
 * bug 形态：catch 分支经 activeSessions.get(sessionKey) 重查计数——跨帧删除
 * （destroy() 外部 abort→delete / 同键并发 invoke 互踩）先于 catch 读取时，
 * 重查 undefined 退化为 0，中断文案与统计失真。修复：优先取 activeEntry 闭包引用。
 *
 * 测试策略（审视 S1 修复——不做同义反复）：构造 stub session 打进真实
 * _executeWithSession：prompt() 内 emit 两次 tool_execution_start（计数 ++ 落
 * activeEntry），然后**先 delete Map 条目再 reject**——跨帧删除现场。断言捕获的
 * err._toolCallCount === 2。修复前的旧表达式（Map 重查）在本现场必得 0 → 红。
 */

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";

type StubSession = {
  prompt: (text: string) => Promise<void>;
  subscribe: (fn: (event: unknown) => void) => () => void;
  abort: () => Promise<void>;
  getSessionStats: () => { tokens: { input: number; output: number } };
  sessionManager: { getBranch: () => unknown[] };
};

function makeFactory() {
  const db = createTestDb();
  const factory = new PiSessionFactory(
    {
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: {
        getConfig: () => ({ systemPrompt: undefined, otterType: "big", modelAlias: null }),
        setConfig: () => {},
        deleteConfig: () => {},
      } as never,
      otterRepo: new SqliteOtterRepository(db),
    },
    createTestLogger(),
  );
  const internals = factory as unknown as {
    activeSessions: Map<string, { abort: () => Promise<void>; toolCallCount: number; guardAbortReason?: string }>;
    identityBuilder: { buildIdentityPrefix: () => Promise<string>; getOtterName: () => Promise<string> };
    _executeWithSession: (
      otterId: string,
      message: string,
      options: undefined,
      session: StubSession,
      sessionKey: string,
      toolContext: object,
      turnText: { text: string },
    ) => Promise<never>;
  };
  return { internals, db };
}

describe("#763 toolCallCount 快照竞态（真实 catch 分支驱动）", () => {
  it("跨帧删除现场：catch 快照仍得真实计数 2（修复前 Map 重查必得 0）", async () => {
    const { internals, db } = makeFactory();
    const sessionKey = "otter-763:msg-1";

    // 与 _acquirePooled 同构：invoke 开始条目入 Map
    internals.activeSessions.set(sessionKey, { abort: async () => {}, toolCallCount: 0 });

    const handlers: Array<(event: unknown) => void> = [];
    const session: StubSession = {
      subscribe: (fn) => {
        handlers.push(fn);
        return () => {};
      },
      // stub prompt：模拟 LLM 两轮工具调用后，跨帧删除（destroy/共键互踩现场）发生，
      // 然后 SDK 错误到达——catch 读取时条目已删
      prompt: async () => {
        for (const h of handlers) h({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
        for (const h of handlers) h({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash" });
        internals.activeSessions.delete(sessionKey); // 跨帧删除先于 catch 读取（竞态核心）
        throw new Error("SDK abort: prompt rejected after external delete");
      },
      abort: async () => {},
      getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
      sessionManager: { getBranch: () => [] },
    };

    const err = await internals
      ._executeWithSession("otter-763", "hi", undefined, session, sessionKey, {}, { text: "" })
      .catch((e: unknown) => e as Error & { _toolCallCount?: number });

    expect(err).toBeInstanceOf(Error);
    // 修复后：activeEntry 闭包引用 → 2；修复前（Map 重查）：undefined ?? 0 → 0（本断言红）
    expect(err._toolCallCount).toBe(2);
    db.close();
  });

  it("无跨帧删除的常规错误路径：计数同样正确（防修复引入新失真）", async () => {
    const { internals, db } = makeFactory();
    const sessionKey = "otter-763:msg-2";
    internals.activeSessions.set(sessionKey, { abort: async () => {}, toolCallCount: 0 });

    const handlers: Array<(event: unknown) => void> = [];
    const session: StubSession = {
      subscribe: (fn) => {
        handlers.push(fn);
        return () => {};
      },
      prompt: async () => {
        for (const h of handlers) h({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
        throw new Error("plain SDK error, no delete race");
      },
      abort: async () => {},
      getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
      sessionManager: { getBranch: () => [] },
    };

    const err = await internals
      ._executeWithSession("otter-763", "hi", undefined, session, sessionKey, {}, { text: "" })
      .catch((e: unknown) => e as Error & { _toolCallCount?: number });

    expect(err._toolCallCount).toBe(1);
    db.close();
  });
});
