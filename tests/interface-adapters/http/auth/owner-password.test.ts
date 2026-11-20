/**
 * 登录口令（owner password）值源单测。
 * 覆盖：config auth.ownerPassword 优先、文件复用、首启生成（0600）、常数时间比对；
 * 以及「env 已废弃，不再参与判定」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEPRECATED_OWNER_PASSWORD_ENV,
  OWNER_PASSWORD_FILENAME,
  generateOwnerPassword,
  resolveOwnerPassword,
  verifyOwnerPassword,
} from "../../../../src/interface-adapters/http/auth/owner-password";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "owner-password-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("登录口令（owner password）：值源解析", () => {
  it("config 优先于文件（配了就是配了，不再有 env 这一层截胡）", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_PASSWORD_FILENAME), "from-file\n", { mode: 0o600 });
    const password = resolveOwnerPassword({ configuredPassword: "from-config", dataDir: dir });
    expect(password).toBe("from-config");
  });

  it("config auth.ownerPassword 优先于文件（可自定义、能记住的固定登录密码）", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_PASSWORD_FILENAME), "from-file\n", { mode: 0o600 });
    const password = resolveOwnerPassword({ configuredPassword: "my-rememberable-pwd", dataDir: dir });
    expect(password).toBe("my-rememberable-pwd");
  });

  it("config auth.ownerPassword 生效时不落盘文件", () => {
    const password = resolveOwnerPassword({ configuredPassword: "pwd-only", dataDir: dir });
    expect(password).toBe("pwd-only");
    expect(() => readFileSync(path.join(dir, OWNER_PASSWORD_FILENAME))).toThrow();
  });

  it("config auth.ownerPassword 为空白时回落文件/生成", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_PASSWORD_FILENAME), "from-file\n", { mode: 0o600 });
    expect(resolveOwnerPassword({ configuredPassword: "  ", dataDir: dir })).toBe("from-file");
  });

  it("旧 env 值源已废弃：残留变量不能覆盖 config 或口令文件", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_PASSWORD_FILENAME), "from-file\n", { mode: 0o600 });
    const previous = process.env[DEPRECATED_OWNER_PASSWORD_ENV];
    try {
      process.env[DEPRECATED_OWNER_PASSWORD_ENV] = "from-deprecated-env";
      expect(resolveOwnerPassword({ dataDir: dir })).toBe("from-file");
      expect(resolveOwnerPassword({ dataDir: dir, configuredPassword: "from-config" })).toBe("from-config");
    } finally {
      if (previous === undefined) delete process.env[DEPRECATED_OWNER_PASSWORD_ENV];
      else process.env[DEPRECATED_OWNER_PASSWORD_ENV] = previous;
    }
  });

  it("config 口令覆盖既有文件时记 warn（避免运维拿旧值困惑）", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_PASSWORD_FILENAME), "old-file-password\n", { mode: 0o600 });
    const warn = vi.fn();
    const password = resolveOwnerPassword({
      configuredPassword: "new-config-pwd",
      dataDir: dir,
      logger: { info: () => {}, warn },
    });
    expect(password).toBe("new-config-pwd");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("文件已存在但空白 → 抛错（损坏宁 fail 不静默换口令）", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_PASSWORD_FILENAME), "\n  \n", { mode: 0o600 });
    expect(() => resolveOwnerPassword({ dataDir: dir })).toThrow(/空白/);
  });

  it("文件已存在则复用（会话跨重启可续）", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, OWNER_PASSWORD_FILENAME), "persisted-password\n", { mode: 0o600 });
    expect(resolveOwnerPassword({ dataDir: dir })).toBe("persisted-password");
  });

  it("首启生成：文件 0600、内容与返回值一致", () => {
    const password = resolveOwnerPassword({ dataDir: dir });
    const filePath = path.join(dir, OWNER_PASSWORD_FILENAME);
    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(filePath, "utf8").trim()).toBe(password);
  });

  it("生成口令为 base64url 无歧义字符形态", () => {
    expect(generateOwnerPassword()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe("verifyOwnerPassword", () => {
  it("常数时间比对：命中/未命中/长度不同", () => {
    expect(verifyOwnerPassword("abc", "abc")).toBe(true);
    expect(verifyOwnerPassword("abc", "abd")).toBe(false);
    expect(verifyOwnerPassword("long-secret", "short")).toBe(false);
  });
});