import { describe, it, expect } from "vitest";
import {
  canArchiveSession,
  archiveReasonToSessionStatus,
  buildNewSession,
} from "../../../src/entities/otter/otter-session";

describe("canArchiveSession", () => {
  it("active session can be archived", () => {
    expect(canArchiveSession("active")).toBe(true);
  });

  it("archived session cannot be archived again", () => {
    expect(canArchiveSession("archived")).toBe(false);
  });

  it("restarted session cannot be archived", () => {
    expect(canArchiveSession("restarted")).toBe(false);
  });
});

describe("archiveReasonToSessionStatus", () => {
  it("restart reason maps to restarted status", () => {
    expect(archiveReasonToSessionStatus("restart")).toBe("restarted");
  });

  it("dissolve reason maps to archived status", () => {
    expect(archiveReasonToSessionStatus("dissolve")).toBe("archived");
  });

  it("token_threshold reason maps to archived status", () => {
    expect(archiveReasonToSessionStatus("token_threshold")).toBe("archived");
  });

  it("empty reason maps to archived status", () => {
    expect(archiveReasonToSessionStatus("")).toBe("archived");
  });
});

describe("buildNewSession (F20260805rsto)", () => {
  it("构造 active 首世 session：无前序、无摘要", () => {
    const s = buildNewSession("otter-1", null);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.otterId).toBe("otter-1");
    expect(s.status).toBe("active");
    expect(s.previousSessionId).toBeNull();
    expect(s.summary).toBeNull();
    expect(s.archivedAt).toBeNull();
    expect(s.archiveReason).toBeNull();
    expect(s.isNegativeCase).toBe(false);
    expect(new Date(s.startedAt).getTime()).not.toBeNaN();
  });

  it("携带前序指针与摘要（restart 建链 + 前情注入新行）", () => {
    const s = buildNewSession("otter-1", "prev-session", "前情摘要");
    expect(s.previousSessionId).toBe("prev-session");
    expect(s.summary).toBe("前情摘要");
  });
});
