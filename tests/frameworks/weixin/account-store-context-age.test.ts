/**
 * WeixinAccountStore context_token v2 格式测试（F20260901wxnt）
 *
 * 断言行为（副作用），不断言内部调用细节。
 * 覆盖：v1 mtime 兼容 / v2 往返 / save 保留其他用户条目并清 warnedAt / recordContextTokenWarned
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WeixinAccountStore } from "@frameworks/weixin/account-store";

describe("WeixinAccountStore - context_token v2 (F20260901wxnt)", () => {
  let tmpDir: string;
  let store: WeixinAccountStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-ctx-test-"));
    store = new WeixinAccountStore({ stateDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("v1 字符串格式读取：loadRawContextTokens 用文件 mtime 回填 receivedAt", () => {
    // 手写 v1 格式文件（值为纯字符串）
    const accountId = "acc-v1";
    const dir = path.join(tmpDir, accountId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "context-tokens.json");
    fs.writeFileSync(filePath, JSON.stringify({ user1: "token-abc", user2: "token-def" }));
    // 取实际 mtimeMs 作为基准（文件系统精度因平台而异）
    const actualMtime = fs.statSync(filePath).mtimeMs;

    const raw = store.loadRawContextTokens(accountId);

    expect(raw.user1.token).toBe("token-abc");
    expect(raw.user1.receivedAt).toBe(actualMtime);
    expect(raw.user1.warnedAt).toBeUndefined();
    expect(raw.user2.token).toBe("token-def");
    expect(raw.user2.receivedAt).toBe(actualMtime);
  });

  it("v1 → loadContextTokens 投影：对外签名不变，返回 Record<string, string>", () => {
    const accountId = "acc-proj";
    const dir = path.join(tmpDir, accountId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "context-tokens.json"), JSON.stringify({ u1: "tok-1" }));

    const projected = store.loadContextTokens(accountId);

    expect(projected).toEqual({ u1: "tok-1" });
    expect(typeof projected.u1).toBe("string");
  });

  it("v2 往返：loadRawContextTokens 读回完整结构", () => {
    const accountId = "acc-v2";
    store.saveContextToken(accountId, "user-a", "tok-a");

    const raw = store.loadRawContextTokens(accountId);

    expect(raw["user-a"].token).toBe("tok-a");
    expect(raw["user-a"].receivedAt).toBeGreaterThan(0);
    expect(raw["user-a"].warnedAt).toBeUndefined();
  });

  it("saveContextToken 保留其他用户的 v2 元数据（receivedAt/warnedAt 不丢失）", () => {
    const accountId = "acc-retain";
    // 写两个用户
    store.saveContextToken(accountId, "u1", "tok-1");
    // 给 u1 记一次预警
    store.recordContextTokenWarned(accountId, "u1");
    const u1Before = store.loadRawContextTokens(accountId)["u1"];
    expect(u1Before.warnedAt).toBeDefined();

    // 写 u2（不应破坏 u1 的 warnedAt）
    store.saveContextToken(accountId, "u2", "tok-2");

    const after = store.loadRawContextTokens(accountId);
    expect(after["u1"].token).toBe("tok-1");
    expect(after["u1"].warnedAt).toBe(u1Before.warnedAt); // preserved
    expect(after["u2"].token).toBe("tok-2");
    expect(after["u2"].warnedAt).toBeUndefined();
  });

  it("saveContextToken 清除该用户的 warnedAt（入站换新 = 用户说话 = 预警使命完成）", () => {
    const accountId = "acc-clear";
    store.saveContextToken(accountId, "u1", "tok-old");
    store.recordContextTokenWarned(accountId, "u1");
    expect(store.loadRawContextTokens(accountId)["u1"].warnedAt).toBeDefined();

    // 入站换新 token
    store.saveContextToken(accountId, "u1", "tok-new");

    const entry = store.loadRawContextTokens(accountId)["u1"];
    expect(entry.token).toBe("tok-new");
    expect(entry.warnedAt).toBeUndefined(); // cleared
  });

  it("recordContextTokenWarned：记 warnedAt（后续 read 可见）", () => {
    const accountId = "acc-warn";
    store.saveContextToken(accountId, "u1", "tok-1");

    store.recordContextTokenWarned(accountId, "u1");

    const entry = store.loadRawContextTokens(accountId)["u1"];
    expect(entry.warnedAt).toBeGreaterThan(0);
  });

  it("recordContextTokenWarned：无条目时静默忽略（不炸）", () => {
    const accountId = "acc-nowarn";
    // 不写任何 token，直接 record
    expect(() => store.recordContextTokenWarned(accountId, "ghost")).not.toThrow();
  });

  it("loadRawContextTokens：空文件返回空对象", () => {
    expect(store.loadRawContextTokens("nonexistent")).toEqual({});
  });

  it("v2 文件中 warnedAt 为数字时正确读回", () => {
    const accountId = "acc-v2-raw";
    const dir = path.join(tmpDir, accountId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "context-tokens.json"),
      JSON.stringify({ u1: { token: "tok", receivedAt: 1000, warnedAt: 2000 } }),
    );

    const raw = store.loadRawContextTokens(accountId);
    expect(raw.u1.token).toBe("tok");
    expect(raw.u1.receivedAt).toBe(1000);
    expect(raw.u1.warnedAt).toBe(2000);
  });
});
