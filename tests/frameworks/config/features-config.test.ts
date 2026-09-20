/**
 * F20260915cfgt：features 配置门测试
 *
 * 覆盖两层：
 * 1. 配置层 buildFeaturesConfig（经 loadConfig 验证）：三态归一化（显式 true/false、
 *    null 不 warn、非法值 warn 归 undefined、未配置全 undefined）
 * 2. 装配层 gateOn / resolveFeatureGates：显式短路不查 DB、存量推断、
 *    recruiting 双通道（apiKey 或 DB 存量）
 *
 * F20260917swsh：dailyReview 开关随每日复盘任务一并移除，相关用例同步删除。
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

const MINIMAL_YAML = "llm:\n  models:\n    - alias: main\n      provider: openai\n      model: gpt-4o\n      handoffThresholdTokens: 40000\n";

mockExistsSync.mockReturnValue(true);
mockReadFileSync.mockReturnValue(MINIMAL_YAML);

let loadConfig: typeof import("../../../src/frameworks/config-service").loadConfig;
let gateOn: typeof import("../../../src/bootstrap/feature-gates").gateOn;
let resolveFeatureGates: typeof import("../../../src/bootstrap/feature-gates").resolveFeatureGates;

beforeAll(async () => {
  const configMod = await import("../../../src/frameworks/config-service");
  loadConfig = configMod.loadConfig;
  const gatesMod = await import("../../../src/bootstrap/feature-gates");
  gateOn = gatesMod.gateOn;
  resolveFeatureGates = gatesMod.resolveFeatureGates;
});

/** 造一个假的 ScheduledTaskRepository（只需要 getAllActive 的 name/status） */
function makeTaskRepo(names: string[]) {
  return {
    getAllActive: vi.fn().mockResolvedValue(names.map(n => ({ name: n, status: "active" }))),
    getByConversationId: vi.fn().mockResolvedValue([]),
  } as unknown as Parameters<typeof resolveFeatureGates>[0]["scheduledTaskRepo"];
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

describe("配置层：buildFeaturesConfig 三态归一化", () => {
  it("未配置 features 段 → 三字段全 undefined（缺省决策在装配层）", () => {
    mockReadFileSync.mockReturnValue(MINIMAL_YAML);
    const config = loadConfig();
    expect(config.features).toEqual({
      selfHealing: undefined,
      recruiting: undefined,
    });
  });

  it("显式 true/false 原样保留", () => {
    mockReadFileSync.mockReturnValue(MINIMAL_YAML + "\nfeatures:\n  selfHealing: false\n  recruiting: true\n");
    const config = loadConfig();
    expect(config.features.recruiting).toBe(true);
    expect(config.features.selfHealing).toBe(false);
  });

  it("null（YAML 空值占位）→ undefined 且不 warn", () => {
    const logger = makeLogger();
    mockReadFileSync.mockReturnValue(MINIMAL_YAML + "\nfeatures:\n  selfHealing: null\n");
    const config = loadConfig(logger);
    expect(config.features.selfHealing).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("非法值（字符串）→ undefined 且 warn", () => {
    const logger = makeLogger();
    mockReadFileSync.mockReturnValue(MINIMAL_YAML + "\nfeatures:\n  recruiting: \"yes\"\n");
    const config = loadConfig(logger);
    expect(config.features.recruiting).toBeUndefined();
    const warnMessages = logger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((m: string) => m.includes("features.recruiting"))).toBe(true);
  });
});

describe("装配层：gateOn 三态门", () => {
  it("显式 true/false 短路，不执行推断回调", async () => {
    let inferCalled = false;
    const infer = async () => { inferCalled = true; return false; };
    expect(await gateOn(true, infer)).toBe(true);
    expect(await gateOn(false, infer)).toBe(false);
    expect(inferCalled).toBe(false);
  });

  it("undefined 时走推断", async () => {
    let inferCalls = 0;
    const infer = async () => { inferCalls++; return true; };
    expect(await gateOn(undefined, infer)).toBe(true);
    expect(inferCalls).toBe(1);
  });
});

describe("装配层：resolveFeatureGates", () => {
  const noFeatures = {
    selfHealing: undefined,
    recruiting: undefined,
  };

  it("空库（无存量任务、无 apiKey）→ 缺省值全 off", async () => {
    const logger = makeLogger();
    const gates = await resolveFeatureGates({
      features: noFeatures,
      scheduledTaskRepo: makeTaskRepo([]),
      logger,
    });
    expect(gates).toEqual({
      selfHealing: false,
      recruiting: false,
    });
  });

  it("DB 有 active self-healing-analysis → selfHealing 推断 on + info 日志", async () => {
    const logger = makeLogger();
    const gates = await resolveFeatureGates({
      features: noFeatures,
      scheduledTaskRepo: makeTaskRepo(["self-healing-analysis"]),
      logger,
    });
    expect(gates.selfHealing).toBe(true);
    const infoMessages = logger.info.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoMessages.some((m: string) => m.includes("selfHealing"))).toBe(true);
  });

  it("recruiting 双通道：apiKey 存在即 on（无 DB 存量）", async () => {
    const gates = await resolveFeatureGates({
      features: noFeatures,
      scheduledTaskRepo: makeTaskRepo([]),
      recruitingApiKey: "sk-test",
      logger: makeLogger(),
    });
    expect(gates.recruiting).toBe(true);
  });

  it("recruiting 双通道：DB 有 recruiting-daily-summary 亦 on（无 apiKey）", async () => {
    const gates = await resolveFeatureGates({
      features: noFeatures,
      scheduledTaskRepo: makeTaskRepo(["recruiting-daily-summary"]),
      logger: makeLogger(),
    });
    expect(gates.recruiting).toBe(true);
  });

  it("显式 recruiting:false 压过 apiKey 推断", async () => {
    const logger = makeLogger();
    const gates = await resolveFeatureGates({
      features: { ...noFeatures, recruiting: false },
      scheduledTaskRepo: makeTaskRepo([]),
      recruitingApiKey: "sk-test",
      logger,
    });
    expect(gates.recruiting).toBe(false);
    // 显式短路：不应触发任何推断 info 日志
    const infoMessages = logger.info.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoMessages.some((m: string) => m.includes("recruiting"))).toBe(false);
  });

  it("显式配置压过全部存量推断（老部署显式关停场景）", async () => {
    const logger = makeLogger();
    const gates = await resolveFeatureGates({
      features: { selfHealing: false, recruiting: undefined },
      scheduledTaskRepo: makeTaskRepo(["self-healing-analysis", "recruiting-daily-summary"]),
      logger,
    });
    expect(gates.selfHealing).toBe(false);
    expect(gates.recruiting).toBe(true); // 未显式配置，存量推断生效
  });
});

