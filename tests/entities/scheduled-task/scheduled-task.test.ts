import { describe, it, expect } from "vitest";
import {
  canTransitionTaskStatus,
  isValidCronExpression,
  isValidTimezone,
  isValidTriggerAt,
} from "../../../src/entities/scheduled-task/scheduled-task";

describe("canTransitionTaskStatus", () => {
  it("active -> disabled is valid", () => {
    expect(canTransitionTaskStatus("active", "disabled")).toBe(true);
  });

  it("active -> error is valid", () => {
    expect(canTransitionTaskStatus("active", "error")).toBe(true);
  });

  it("active -> active is invalid (same state)", () => {
    expect(canTransitionTaskStatus("active", "active")).toBe(false);
  });

  it("disabled -> active is valid", () => {
    expect(canTransitionTaskStatus("disabled", "active")).toBe(true);
  });

  it("disabled -> disabled is invalid (same state)", () => {
    expect(canTransitionTaskStatus("disabled", "disabled")).toBe(false);
  });

  it("disabled -> error is invalid", () => {
    expect(canTransitionTaskStatus("disabled", "error")).toBe(false);
  });

  it("error -> active is valid", () => {
    expect(canTransitionTaskStatus("error", "active")).toBe(true);
  });

  it("error -> disabled is valid", () => {
    expect(canTransitionTaskStatus("error", "disabled")).toBe(true);
  });

  it("error -> error is invalid (same state)", () => {
    expect(canTransitionTaskStatus("error", "error")).toBe(false);
  });
});

describe("isValidCronExpression", () => {
  it("valid 5-field expression", () => {
    expect(isValidCronExpression("0 9 * * *")).toBe(true);
  });

  it("valid expression with ranges and steps", () => {
    expect(isValidCronExpression("*/5 9-17 * * 1-5")).toBe(true);
  });

  it("valid expression with comma-separated values", () => {
    expect(isValidCronExpression("0 9,12,18 * * *")).toBe(true);
  });

  it("4 fields is invalid", () => {
    expect(isValidCronExpression("0 9 * *")).toBe(false);
  });

  it("6 fields is invalid", () => {
    expect(isValidCronExpression("0 9 * * * *")).toBe(false);
  });

  it("empty string is invalid", () => {
    expect(isValidCronExpression("")).toBe(false);
  });

  it("whitespace-only is invalid", () => {
    expect(isValidCronExpression("   ")).toBe(false);
  });

  it("invalid characters are rejected", () => {
    expect(isValidCronExpression("0 9 * * abc")).toBe(false);
  });
});

describe("isValidTriggerAt", () => {
  it("valid ISO 8601 datetime is accepted", () => {
    expect(isValidTriggerAt("2026-08-11T17:00:00+08:00")).toBe(true);
  });

  it("valid ISO 8601 UTC is accepted", () => {
    expect(isValidTriggerAt("2026-08-11T09:00:00Z")).toBe(true);
  });

  it("date-only string is rejected (no T separator)", () => {
    expect(isValidTriggerAt("2026-08-11")).toBe(false);
  });

  it("non-date string is rejected", () => {
    expect(isValidTriggerAt("not-a-date")).toBe(false);
  });

  it("empty string is rejected", () => {
    expect(isValidTriggerAt("")).toBe(false);
  });

  it("human-readable string is rejected", () => {
    expect(isValidTriggerAt("tomorrow at 5pm")).toBe(false);
  });

  it("only time without date is rejected", () => {
    expect(isValidTriggerAt("T17:00:00")).toBe(false);
  });
});

describe("isValidTimezone", () => {
  it("Asia/Shanghai is valid", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
  });

  it("America/New_York is valid", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
  });

  it("UTC is valid", () => {
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("Invalid/Zone is invalid", () => {
    expect(isValidTimezone("Invalid/Zone")).toBe(false);
  });

  it("empty string is invalid", () => {
    expect(isValidTimezone("")).toBe(false);
  });
});
