/**
 * F20260820a4rt: tool-manifest-loader 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { loadToolManifest, getToolNamesFromManifest } from "../../../src/frameworks/config/tool-manifest-loader";
import type { ToolManifest } from "../../../src/frameworks/config/tool-manifest-loader";

const TEST_DIR = join(import.meta.dirname, "__test_manifest__");
const MANIFEST_PATH = join(TEST_DIR, "config/tool-manifest.json");

function createManifest(content: unknown) {
  mkdirSync(join(TEST_DIR, "config"), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(content, null, 2));
}

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

const VALID_MANIFEST: ToolManifest = {
  schemaVersion: 1,
  defaultType: "big",
  types: {
    big: {
      description: "大獭 - 全功能",
      tools: "*",
    },
    small: {
      description: "小獭 - 子集",
      tools: ["speak", "yield", "search_memory"],
    },
  },
};

describe("loadToolManifest", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("should return null when manifest file does not exist", () => {
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when manifest JSON is invalid", () => {
    mkdirSync(join(TEST_DIR, "config"), { recursive: true });
    writeFileSync(MANIFEST_PATH, "{ invalid json }");
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when schemaVersion is missing", () => {
    createManifest({ defaultType: "big", types: {} });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when schemaVersion is not 1", () => {
    createManifest({ schemaVersion: 2, defaultType: "big", types: {} });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when defaultType is missing", () => {
    createManifest({ schemaVersion: 1, types: {} });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when defaultType is not in types", () => {
    createManifest({
      schemaVersion: 1,
      defaultType: "nonexistent",
      types: { big: { description: "test", tools: "*" } },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when types is not an object", () => {
    createManifest({ schemaVersion: 1, defaultType: "big", types: "not an object" });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when type config is missing description", () => {
    createManifest({
      schemaVersion: 1,
      defaultType: "big",
      types: { big: { tools: "*" } },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when type tools is not * or array", () => {
    createManifest({
      schemaVersion: 1,
      defaultType: "big",
      types: { big: { description: "test", tools: "invalid" } },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when tools array contains non-string", () => {
    createManifest({
      schemaVersion: 1,
      defaultType: "big",
      types: { big: { description: "test", tools: [123] } },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should load valid manifest successfully", () => {
    createManifest(VALID_MANIFEST);
    const result = loadToolManifest(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(1);
    expect(result!.defaultType).toBe("big");
    expect(result!.types.big.tools).toBe("*");
    expect(result!.types.small.tools).toEqual(["speak", "yield", "search_memory"]);
  });

  it("should call logger.warn when file not found", () => {
    const warnings: string[] = [];
    const logger = { warn: (msg: string) => warnings.push(msg), error: () => {} };
    loadToolManifest(TEST_DIR, logger);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("manifest 文件不存在");
  });

  it("should call logger.error when JSON is invalid", () => {
    mkdirSync(join(TEST_DIR, "config"), { recursive: true });
    writeFileSync(MANIFEST_PATH, "{ invalid json }");
    const errors: string[] = [];
    const logger = { warn: () => {}, error: (msg: string) => errors.push(msg) };
    loadToolManifest(TEST_DIR, logger);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("JSON 解析失败");
  });
});

describe("getToolNamesFromManifest", () => {
  const allToolNames = ["speak", "yield", "search_memory", "create_otter", "dissolve_otter"];

  it("should return all tools for * wildcard", () => {
    const result = getToolNamesFromManifest(VALID_MANIFEST, "big", allToolNames);
    expect(result).toEqual(allToolNames);
  });

  it("should return subset for specific type", () => {
    const result = getToolNamesFromManifest(VALID_MANIFEST, "small", allToolNames);
    expect(result).toEqual(["speak", "yield", "search_memory"]);
  });

  it("should fallback to defaultType for unknown type", () => {
    const result = getToolNamesFromManifest(VALID_MANIFEST, "unknown", allToolNames);
    expect(result).toEqual(allToolNames); // defaultType is "big" which is "*"
  });

  it("should fallback to allToolNames if defaultType is also missing", () => {
    const manifest: ToolManifest = {
      schemaVersion: 1,
      defaultType: "nonexistent",
      types: {},
    };
    const result = getToolNamesFromManifest(manifest, "unknown", allToolNames);
    expect(result).toEqual(allToolNames);
  });
});
