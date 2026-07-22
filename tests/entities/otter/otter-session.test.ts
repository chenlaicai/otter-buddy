import { describe, it, expect } from "vitest";
import {
  canArchiveSession,
  archiveReasonToSessionStatus,
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
