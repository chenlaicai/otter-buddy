import { describe, it, expect } from "vitest";
import { canTransitionMemoryLayer } from "../../../src/entities/memory/memory-entry";

describe("canTransitionMemoryLayer", () => {
  it("working -> historical is valid", () => {
    expect(canTransitionMemoryLayer("working", "historical")).toBe(true);
  });

  it("historical -> working is valid", () => {
    expect(canTransitionMemoryLayer("historical", "working")).toBe(true);
  });

  it("working -> working is invalid (same state)", () => {
    expect(canTransitionMemoryLayer("working", "working")).toBe(false);
  });

  it("historical -> historical is invalid (same state)", () => {
    expect(canTransitionMemoryLayer("historical", "historical")).toBe(false);
  });

  it("document -> document is invalid (same state)", () => {
    expect(canTransitionMemoryLayer("document", "document")).toBe(false);
  });

  it("working -> document is invalid", () => {
    expect(canTransitionMemoryLayer("working", "document")).toBe(false);
  });

  it("document -> working is invalid", () => {
    expect(canTransitionMemoryLayer("document", "working")).toBe(false);
  });

  it("historical -> document is invalid", () => {
    expect(canTransitionMemoryLayer("historical", "document")).toBe(false);
  });

  it("document -> historical is invalid", () => {
    expect(canTransitionMemoryLayer("document", "historical")).toBe(false);
  });
});
