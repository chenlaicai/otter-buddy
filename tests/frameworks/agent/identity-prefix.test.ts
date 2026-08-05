/**
 * buildIdentityPrefix 分支测试（真 schema + 真 repo）。
 *
 * 端到端的不变量（首次注入、不重复注入）由
 * tests/capability/otter-lifecycle.capability.test.ts 用真系统 + 真 LLM 验证。
 * 本文件只保留能力层覆盖不到的分支：类型优先级/未知类型降级/幽灵獭/目录缺失降级。
 *
 * 明知妥协：buildIdentityPrefix 是私有方法，经 cast 触达——分支密集且能力层无法触发，
 * 保留私有触达是有意的（已删除更深的 _invokeInternal 内部件替换测试）。
 * 文案标记「海獭团队的头儿」「由大獭为完成特定任务而创建」是大小獭身份文件的判别器，改文案需同步。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import path from "node:path";

/** worktree/CI 中无 config/config.yaml，mock 掉避免急切加载配置文件 */
vi.mock("@frameworks/config", () => ({ config: { circuitBreaker: {} } }));

import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

const REAL_IDENTITY_DIR = path.resolve(__dirname, "../../../prompts/identity");

function makeFactory(db: Database.Database, identityPromptDir?: string): PiSessionFactory {
  return new PiSessionFactory({
    db,
    sessionDir: ":memory:",
    otterToolClient: {} as never,
    model: null,
    identityPromptDir,
    createTools: () => [],
    otterConfigProvider: new SqliteOtterConfigProvider(db),
    otterRepo: new SqliteOtterRepository(db),
  }, createTestLogger());
}

async function buildIdentityPrefix(factory: PiSessionFactory, otterId: string, otterType: string): Promise<string> {
  return (factory as unknown as { buildIdentityPrefix(id: string, type: string): Promise<string> })
    .buildIdentityPrefix(otterId, otterType);
}

describe("buildIdentityPrefix 分支", () => {
  let db: Database.Database;
  let repo: SqliteOtterRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteOtterRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  async function seedOtter(id: string, name: string, type: "big" | "small"): Promise<void> {
    await repo.createOtter({
      id, name, type, status: "active",
      role: null, parentOtterId: null, createdAt: new Date().toISOString(), dissolvedAt: null,
    });
  }

  it("大獭：头部字段 + 大獭身份正文（frontmatter 已剥离）", async () => {
    await seedOtter("o-big", "大獭", "big");
    const prefix = await buildIdentityPrefix(makeFactory(db, REAL_IDENTITY_DIR), "o-big", "big");

    expect(prefix).toContain("名称：大獭");
    expect(prefix).toContain("ID：o-big");
    expect(prefix).toContain("类型：大獭");
    expect(prefix).toContain("海獭团队的头儿");
    expect(prefix).not.toContain("name: big-otter-identity");
  });

  it("小獭：以 otterType 参数为准（即使 DB type 字段不一致）", async () => {
    await seedOtter("o-small", "开发者", "big");
    const prefix = await buildIdentityPrefix(makeFactory(db, REAL_IDENTITY_DIR), "o-small", "small");

    expect(prefix).toContain("类型：小獭");
    expect(prefix).toContain("由大獭为完成特定任务而创建");
  });

  it("未知类型按小獭处理（保守默认）", async () => {
    await seedOtter("o-x", "某獭", "big");
    const prefix = await buildIdentityPrefix(makeFactory(db, REAL_IDENTITY_DIR), "o-x", "weird");

    expect(prefix).toContain("类型：小獭");
    expect(prefix).toContain("由大獭为完成特定任务而创建");
  });

  it("otter 不存在时返回空串", async () => {
    await expect(buildIdentityPrefix(makeFactory(db, REAL_IDENTITY_DIR), "ghost", "big")).resolves.toBe("");
  });

  it("身份文件目录缺失：降级为仅头部（不含身份正文）", async () => {
    await seedOtter("o-big", "大獭", "big");
    const prefix = await buildIdentityPrefix(makeFactory(db, "/nonexistent/identity/dir"), "o-big", "big");

    expect(prefix).toContain("名称：大獭");
    expect(prefix).toContain("类型：大獭");
    expect(prefix).not.toContain("海獭团队的头儿");
  });
});
