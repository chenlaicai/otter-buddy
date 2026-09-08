/**
 * F20260908efmd: resolveEffectiveModel 单元测试。
 *
 * 覆盖场景：
 * - AT-1: config 有 modelAlias → 用值 + isDefault=false
 * - AT-2: config 无 modelAlias（空字符串/undefined）→ 回退默认 + isDefault=true
 * - AT-3: config 为 null（该 otter 无配置记录）→ 回退默认 + isDefault=true
 * - AT-4: config 不存在 → 回退默认 + isDefault=true
 */
import { describe, it, expect } from "vitest";
import { resolveEffectiveModel } from "@usecases/ports/otter-config-provider";
import type { OtterConfig } from "@usecases/ports/otter-config-provider";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";

const mockPool: Pick<ModelPoolLike, "getDefaultAlias"> = {
  getDefaultAlias: () => "main",
};

describe("resolveEffectiveModel (F20260908efmd)", () => {
  it("AT-1: config 有 modelAlias → 用值 + isDefault=false", () => {
    const config: OtterConfig = { otterType: "big", modelAlias: "kimi" };
    const result = resolveEffectiveModel(config, mockPool);
    expect(result.alias).toBe("kimi");
    expect(result.isDefault).toBe(false);
  });

  it("AT-2: config 无 modelAlias（undefined）→ 回退默认 + isDefault=true", () => {
    const config: OtterConfig = { otterType: "big" };
    const result = resolveEffectiveModel(config, mockPool);
    expect(result.alias).toBe("main");
    expect(result.isDefault).toBe(true);
  });

  it("AT-2b: config 无 modelAlias（空字符串）→ 回退默认 + isDefault=true", () => {
    const config: OtterConfig = { otterType: "big", modelAlias: "" };
    const result = resolveEffectiveModel(config, mockPool);
    expect(result.alias).toBe("main");
    expect(result.isDefault).toBe(true);
  });

  it("AT-3: config 为 null → 回退默认 + isDefault=true", () => {
    const result = resolveEffectiveModel(null, mockPool);
    expect(result.alias).toBe("main");
    expect(result.isDefault).toBe(true);
  });

  it("AT-4: config 为 undefined → 回退默认 + isDefault=true", () => {
    const result = resolveEffectiveModel(undefined, mockPool);
    expect(result.alias).toBe("main");
    expect(result.isDefault).toBe(true);
  });
});
