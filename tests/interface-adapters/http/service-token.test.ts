/**
 * 服务令牌解析与校验：外部来源（跳反代/跨主机）唯一可编程凭据。
 *
 * 为什么值得单测：这层的失效形态都很贵——令牌太短等于没有（可猜中）、
 * env 与配置文件优先级搞反会让部署面改不动、比较不走常数时间就没泄露意图但
 * 走常量的成本几乎为零。这里把三者都钉住。
 */
import { describe, it, expect } from "vitest";
import {
  createServiceTokenVerifier,
  resolveServiceToken,
  SERVICE_TOKEN_MIN_LENGTH,
} from "../../../src/interface-adapters/http/auth/service-token";

const TOKEN = "tp".repeat(16); // 32 字符

describe("resolveServiceToken：优先级与 fail-fast", () => {
  it("env 优先于配置文件（部署面可覆盖仓内默认）", () => {
    expect(resolveServiceToken({ env: { OTTER_SERVICE_TOKEN: TOKEN }, configured: "config-token-1234567890" })).toBe(TOKEN);
  });

  it("env 缺省/空白时回落到配置；两者皆空 = 未配置（通道不存在）", () => {
    expect(resolveServiceToken({ env: {}, configured: `  ${TOKEN}  ` })).toBe(TOKEN);
    expect(resolveServiceToken({ env: { OTTER_SERVICE_TOKEN: "   " }, configured: TOKEN })).toBe(TOKEN);
    expect(resolveServiceToken({ env: {}, configured: "   " })).toBeUndefined();
    expect(resolveServiceToken()).toBeUndefined();
  });

  it("太短直接抛错（唯一凭据可猜中等于没有），并指出两个来源", () => {
    expect(() => resolveServiceToken({ env: { OTTER_SERVICE_TOKEN: "short" } }))
      .toThrow(/至少 16 个字符/);
    expect(() => resolveServiceToken({ env: { OTTER_SERVICE_TOKEN: "short" } }))
      .toThrow(/OTTER_SERVICE_TOKEN/);
    expect(() => resolveServiceToken({ configured: "x".repeat(SERVICE_TOKEN_MIN_LENGTH - 1) }))
      .toThrow(/serviceToken/);
  });

  it("边界长度可用", () => {
    expect(resolveServiceToken({ configured: "x".repeat(SERVICE_TOKEN_MIN_LENGTH) })).toHaveLength(SERVICE_TOKEN_MIN_LENGTH);
  });
});

describe("createServiceTokenVerifier：命中给固定服务身份", () => {
  it("匹配 → service-token/admin；不匹配/空串/超长 → null", () => {
    const verify = createServiceTokenVerifier(TOKEN);
    expect(verify(TOKEN)).toEqual({ userId: "service-token", role: "admin" });
    expect(verify(`${TOKEN}x`)).toBeNull();
    expect(verify(TOKEN.slice(1))).toBeNull();
    expect(verify("")).toBeNull();
  });
});
