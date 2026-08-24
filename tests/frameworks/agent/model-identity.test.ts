/**
 * buildIdentityPrefix 模型身份段测试（F20260824mdlid）。
 *
 * 验证：
 * - 多模型池 + 传入 modelAlias → 包含"你的运行时模型"段
 * - 多模型池 + 不传 modelAlias → 使用默认模型
 * - 单模型池 → 省略该段（信息量为零）
 * - modelAlias 不在池中 → 使用默认模型
 * - modelPool 未配置 → 省略该段
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import path from "node:path";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { IdentityBuilder } from "@frameworks/agent/identity-builder";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import type { ModelPool, ModelDescriptor } from "@frameworks/llm/model-pool";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

const REAL_IDENTITY_DIR = path.resolve(__dirname, "../../../prompts/identity");

function makeModelPool(descriptors: ModelDescriptor[]): ModelPool {
  return {
    describeModels: () => descriptors,
    getDefaultAlias: () => descriptors[0]?.alias ?? "default",
    getModel: () => null as never,
    hasModel: (alias: string) => descriptors.some(d => d.alias === alias),
  } as unknown as ModelPool;
}

const MULTI_MODEL: ModelDescriptor[] = [
  { alias: "mimo", description: "小米 MiMo 推理模型", strengths: ["强推理", "代码能力优秀"], weaknesses: ["中文略逊"] },
  { alias: "kimi", description: "Kimi K3 长上下文模型", strengths: ["超长上下文"], weaknesses: ["推理略慢"] },
  { alias: "glm", description: "智谱 GLM-5.3", strengths: ["中文能力强"], weaknesses: ["推理略逊于 mimo"] },
];

const SINGLE_MODEL: ModelDescriptor[] = [
  { alias: "only", description: "唯一模型", strengths: ["通用"], weaknesses: [] },
];

describe("buildIdentityPrefix 模型身份段（F20260824mdlid）", () => {
  let db: Database.Database;
  let repo: SqliteOtterRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteOtterRepository(db);
  });

  afterEach(() => { db.close(); });

  async function seedOtter(id: string, name: string, type: "big" | "small") {
    await repo.createOtter({
      id, name, type, status: "active",
      role: null, parentOtterId: null, createdAt: new Date().toISOString(), dissolvedAt: null,
    });
  }

  function makeBuilder(modelPool?: ModelPool): IdentityBuilder {
    return new IdentityBuilder(repo, undefined, modelPool, createTestLogger(), REAL_IDENTITY_DIR);
  }

  it("多模型池 + 指定 modelAlias → 包含对应模型的身份段", async () => {
    await seedOtter("o1", "开发獭", "small");
    const prefix = await makeBuilder(makeModelPool(MULTI_MODEL)).buildIdentityPrefix("o1", "small", "", "mimo");

    expect(prefix).toContain("你的运行时模型");
    expect(prefix).toContain("mimo");
    expect(prefix).toContain("小米 MiMo 推理模型");
    expect(prefix).toContain("强推理");
    expect(prefix).toContain("以上信息由系统注入");
    expect(prefix).toContain("对抗性协作提示");
  });

  it("多模型池 + 不传 modelAlias → 使用默认模型", async () => {
    await seedOtter("o1", "开发獭", "small");
    const prefix = await makeBuilder(makeModelPool(MULTI_MODEL)).buildIdentityPrefix("o1", "small", "");

    expect(prefix).toContain("你的运行时模型");
    expect(prefix).toContain("mimo"); // MULTI_MODEL[0] = 默认
  });

  it("多模型池 + 不同 alias → 展示对应模型的优势", async () => {
    await seedOtter("o1", "检视獭", "small");
    const prefix = await makeBuilder(makeModelPool(MULTI_MODEL)).buildIdentityPrefix("o1", "small", "", "glm");

    expect(prefix).toContain("glm");
    expect(prefix).toContain("中文能力强");
    expect(prefix).not.toContain("mimo——");
  });

  it("单模型池 → 省略模型身份段", async () => {
    await seedOtter("o1", "开发獭", "small");
    const prefix = await makeBuilder(makeModelPool(SINGLE_MODEL)).buildIdentityPrefix("o1", "small", "", "only");

    expect(prefix).not.toContain("你的运行时模型");
    expect(prefix).toContain("类型：小獭");
  });

  it("modelPool 未配置 → 省略模型身份段", async () => {
    await seedOtter("o1", "开发獭", "small");
    const prefix = await makeBuilder(undefined).buildIdentityPrefix("o1", "small", "", "mimo");

    expect(prefix).not.toContain("你的运行时模型");
  });

  it("modelAlias 不在池中 → 回退到默认模型", async () => {
    await seedOtter("o1", "开发獭", "small");
    const prefix = await makeBuilder(makeModelPool(MULTI_MODEL)).buildIdentityPrefix("o1", "small", "", "nonexistent");

    expect(prefix).toContain("你的运行时模型");
    expect(prefix).toContain("mimo");
  });
});
