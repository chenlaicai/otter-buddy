/**
 * 阶段 2（F20261113uaccs）：owner token 值源单测。
 * 覆盖：env 优先、文件复用、首启生成（0600）、常数时间比对。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OWNER_TOKEN_ENV,
  OWNER_TOKEN_FILENAME,
  generateOwnerToken,
  resolveOwnerToken,
  verifyOwnerToken,
} from "../../../../src/interface-adapters/http/auth/owner-token";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "owner-token-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("owner-token：值源解析", () => {
  it("env 优先于文件（alpha/e2e/生产三态显式注入）", () => {
    const token = resolveOwnerToken({ env: { [OWNER_TOKEN_ENV]: "from-env" }, dataDir: dir });
    expect(token).toBe("from-env");
  });

  it("env 为空串时不采信，回落文件生成", () => {
    const token = resolveOwnerToken({ env: { [OWNER_TOKEN_ENV]: "  " }, dataDir: dir });
    expect(token).not.toBe("  ");
    expect(token.length).toBeGreaterThan(20);
  });

  it("文件已存在但空白 → 抛错（损坏宁 fail 不静默换 token）", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_TOKEN_FILENAME), "\n  \n", { mode: 0o600 });
    expect(() => resolveOwnerToken({ dataDir: dir })).toThrow(/blank/);
  });

  it("文件已存在则复用（会话跨重启可续）", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_TOKEN_FILENAME), "persisted-token\n", { mode: 0o600 });
    expect(resolveOwnerToken({ dataDir: dir })).toBe("persisted-token");
  });

  it("首启生成：文件 0600、内容与返回值一致", () => {
    const token = resolveOwnerToken({ dataDir: dir });
    const filePath = path.join(dir, OWNER_TOKEN_FILENAME);
    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(filePath, "utf8").trim()).toBe(token);
  });

  it("生成 token 为 base64url 无歧义字符形态", () => {
    expect(generateOwnerToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe("verifyOwnerToken", () => {
  it("常数时间比对：命中/未命中/长度不同", () => {
    expect(verifyOwnerToken("abc", "abc")).toBe(true);
    expect(verifyOwnerToken("abc", "abd")).toBe(false);
    expect(verifyOwnerToken("long-secret", "short")).toBe(false);
  });
});