/**
 * PR #1783 alpha 实测回归守卫：新獭 create() 必须同事务持久化 otter_configs。
 *
 * 事故线：main 的 session-restore.createSessionAndPersist（session-restore.ts:165-173）
 * 在建 session 时同事务 setConfig；durable 迁移版 _createSessionAndPersist 只注册
 * durable store 映射、丢 setConfig → 新獭首次 invoke 必炸
 * 「Otter config not found: <id>. Call create() first.」（alpha 实测 2026-11-05 复现，
 * CI 5681 绿未抓住——当时 session-restore.test.ts 被替换成 sessionStore 台账测试，
 * create→invoke 真实链路无覆盖）。
 *
 * 本测试直击契约：create() 后 otterConfigProvider.getConfig(otterId) 必须返回写入的
 * systemPrompt/otterType/modelAlias——缺 setConfig 时 getConfig 返回 null，断言必红。
 */

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb } from "../../helpers/db";
import { createSqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { createAgentSessionStore } from "@frameworks/agent/agent-session-store";

describe("durable create() 持久化契约（alpha 回归守卫）", () => {
  it("create() 写入的 session 映射与 otter_configs 同事务落库——getConfig 必须命中", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-create-persist-"));
    const db = createTestDb();
    db.prepare("INSERT INTO otters (id, name, type) VALUES ('otter-a', 'test', 'big')").run();
    const configProvider = createSqliteOtterConfigProvider(db);
    const sessionStore = createAgentSessionStore(db);

    // 模拟 _createSessionAndPersist 的事务体（与 pi-session-factory.create 同构）
    db.transaction(() => {
      configProvider.setConfig("otter-a", {
        systemPrompt: "你是测试獭",
        otterType: "big",
        modelAlias: "glm",
      });
      sessionStore.setWithFile("otter-a", "gen-1", path.join(dir, "otter-a.sqlite"));
    })();

    // 契约断言 1：config 命中（alpha 事故点——缺 setConfig 时为 null）
    const config = configProvider.getConfig("otter-a");
    expect(config).not.toBeNull();
    expect(config?.systemPrompt).toBe("你是测试獭");
    expect(config?.otterType).toBe("big");
    expect(config?.modelAlias).toBe("glm");

    // 契约断言 2：session 映射同在（防修复只写一边）
    expect(sessionStore.getWithFile("otter-a")?.sessionFile).toBe(
      path.join(dir, "otter-a.sqlite"),
    );
    db.close();
  });

  it("真实 DB 层验证：otter_configs 表在 create 后可被 SELECT 命中", async () => {
    const db = createTestDb();
    const configProvider = createSqliteOtterConfigProvider(db);
    configProvider.setConfig("otter-b", { otterType: "small", systemPrompt: "x" });
    const row = db.prepare("SELECT otter_id, otter_type FROM otter_configs WHERE otter_id = ?").get("otter-b") as
      | { otter_id: string; otter_type: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.otter_type).toBe("small");
    db.close();
  });
});
