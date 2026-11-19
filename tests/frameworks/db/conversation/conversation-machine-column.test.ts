import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";

/**
 * conversations.current_machine_id 列——
 * 新库建表含列 / 存量库 ALTER 幂等补列 / repo 窄接口读写。
 */

function seedConversation(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO conversations (id, title, status, kind, created_at, updated_at) VALUES (?, ?, 'active', 'normal', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')").run(id, `对话 ${id}`);
}

describe("对话级当前执行机列（阶段 5 PR-A）", () => {
  it("新库：列存在 + 默认 NULL（存量对话语义零变化）；repo 读写切换", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    const repo = new SqliteConversationRepository(db);
    seedConversation(db, "c-1");

    expect(await repo.getExecutionMachineId("c-1")).toBeNull(); // 默认 local

    expect(await repo.setExecutionMachineId("c-1", "connector-b")).toBe(true);
    expect(await repo.getExecutionMachineId("c-1")).toBe("connector-b");

    expect(await repo.setExecutionMachineId("c-1", null)).toBe(true); // 回默认
    expect(await repo.getExecutionMachineId("c-1")).toBeNull();

    expect(await repo.setExecutionMachineId("c-missing", "connector-b")).toBe(false); // 不存在 fail-closed
    expect(await repo.getExecutionMachineId("c-missing")).toBeNull();
    db.close();
  });

  it("存量库（旧表无列）：initSchema ALTER 幂等补列 + 数据保留", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    db.exec("ALTER TABLE conversations DROP COLUMN current_machine_id"); // 还原旧形态（及更早）
    seedConversation(db, "c-old");
    initSchema(db); // ALTER 补列（幂等）

    const repo = new SqliteConversationRepository(db);
    expect(await repo.getExecutionMachineId("c-old")).toBeNull(); // 旧数据保留 + 新列默认 NULL
    expect(await repo.setExecutionMachineId("c-old", "connector-b")).toBe(true);
    expect(await repo.getExecutionMachineId("c-old")).toBe("connector-b");

    initSchema(db); // 再次调用幂等（列已存在不炸）
    db.close();
  });
});
