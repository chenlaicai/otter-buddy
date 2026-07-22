import { describe, it, expect } from "vitest";
import { canDissolveOtter } from "../../../src/entities/otter/otter";

describe("canDissolveOtter", () => {
  it("active otter can be dissolved", () => {
    expect(canDissolveOtter("active")).toBe(true);
  });

  it("dissolved otter cannot be dissolved again", () => {
    expect(canDissolveOtter("dissolved")).toBe(false);
  });
});
