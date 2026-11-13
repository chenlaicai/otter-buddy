/**
 * 阶段 2（F20261113uaccs）：会话 cookie 签名/校验单测。
 * 覆盖：sign→verify 往返、过期拒绝、篡改拒绝、非白名单 role 拒绝、clock 前移拒绝。
 */
import { describe, it, expect } from "vitest";
import { createSessionSigner, SESSION_MAX_AGE_MS } from "../../../../src/interface-adapters/http/auth/session-cookie";

describe("createSessionSigner", () => {
  const signer = createSessionSigner("test-secret");
  const now = 1_700_000_000_000;

  it("sign→verify 往返：可信身份回读", () => {
    const value = signer.sign({ userId: "owner", role: "admin" }, now);
    expect(signer.verify(value, now)).toEqual({ userId: "owner", role: "admin" });
    expect(signer.verify(value, now + SESSION_MAX_AGE_MS - 1)).toEqual({ userId: "owner", role: "admin" });
  });

  it("过期拒绝（now 越过 issuedAt+maxAge）", () => {
    const value = signer.sign({ userId: "owner", role: "admin" }, now);
    // 边界（now = issuedAt+maxAge）仍有效；越过边界即拒绝
    expect(signer.verify(value, now + SESSION_MAX_AGE_MS)).toEqual({ userId: "owner", role: "admin" });
    expect(signer.verify(value, now + SESSION_MAX_AGE_MS + 1)).toBeNull();
    expect(signer.verify(value, now + SESSION_MAX_AGE_MS + 1000)).toBeNull();
  });

  it("时钟回拨（now < issuedAt）拒绝", () => {
    const value = signer.sign({ userId: "owner", role: "admin" }, now);
    expect(signer.verify(value, now - 1)).toBeNull();
  });

  it("篡改任一字段 → 签名不匹配拒绝", () => {
    const value = signer.sign({ userId: "owner", role: "admin" }, now);
    // 把 userId 段改成 admin 但签名未变
    const [, role, issued, maxAge, sig] = value.split(".");
    const forged = ["admin", role, issued, maxAge, sig].join(".");
    expect(forged).not.toBe(value);
    expect(signer.verify(forged, now)).toBeNull();
  });

  it("非白名单 role / 非数值时间 / 段数错误 → 拒绝", () => {
    expect(signer.verify("", now)).toBeNull();
    expect(signer.verify("a.b.c.d", now)).toBeNull(); // 少一段
    const value = signer.sign({ userId: "owner", role: "admin" }, now);
    const [, role, issued, maxAge, sig] = value.split(".");
    expect(signer.verify(["owner", "superadmin", issued, maxAge, sig].join("."), now)).toBeNull();
    expect(signer.verify(["owner", role, "NaN", maxAge, sig].join("."), now)).toBeNull();
  });

  it("不同 secret 无法互验", () => {
    const other = createSessionSigner("other-secret");
    const value = signer.sign({ userId: "owner", role: "admin" }, now);
    expect(other.verify(value, now)).toBeNull();
  });
});