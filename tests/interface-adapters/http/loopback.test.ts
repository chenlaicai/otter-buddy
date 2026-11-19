/**
 * 回环判定单测：监听地址与连接来源共用一套解析。
 *
 * 为什么值得单独钉：这层判定是声明式身份通道的唯一来源闸——`::1` 认不出或
 * `::ffff:127.0.0.1` 被当成外部地址，后果是脚本全挂或鉴权旁路，两种都不能靠人眼保证。
 */
import { describe, it, expect } from "vitest";
import { isLoopbackAddress, isLoopbackHost } from "../../../src/interface-adapters/http/loopback";

describe("isLoopbackHost / isLoopbackAddress", () => {
  it("回环形态全部为真（含方括号与 IPv4-mapped）", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1", " 127.0.0.1 "]) {
      expect(isLoopbackHost(host), host).toBe(true);
      expect(isLoopbackAddress(host), host).toBe(true);
    }
  });

  it("非回环形态为假", () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.1", "203.0.113.9", "::ffff:10.0.0.1", "otter.example.com", "127.0.0.1.example.com"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  it("伪回环串（127 出现在非首段 / 段越界）不被放行", () => {
    for (const host of ["10.0.0.127", "127.0.0.256", "127.0.0", "127.0.0.1.5"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});
