/**
 * F20260820a4rt: tool-manifest-loader 单元测试
 * F20260822a5cb: 新增 capabilityBlocks / groups 测试
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

const VALID_MANIFEST_V2: ToolManifest = {
  schemaVersion: 2,
  defaultType: "big",
  capabilityBlocks: {
    memory: {
      description: "记忆检索与管理",
      tools: ["search_memory", "get_memory_detail"],
    },
    conversation: {
      description: "对话历史查询",
      tools: ["get_message", "list_messages"],
    },
  },
  types: {
    big: {
      description: "大獭 - 全功能",
      tools: "*",
    },
    small: {
      description: "小獭 - 子集",
      groups: ["memory"],
      tools: ["speak", "yield"],
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

  it("should return null when schemaVersion is unsupported", () => {
    createManifest({ schemaVersion: 3, defaultType: "big", types: {} });
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

  it("should load valid v1 manifest successfully", () => {
    createManifest(VALID_MANIFEST);
    const result = loadToolManifest(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(1);
    expect(result!.defaultType).toBe("big");
    expect(result!.types.big.tools).toBe("*");
    expect(result!.types.small.tools).toEqual(["speak", "yield", "search_memory"]);
  });

  it("should load valid v2 manifest successfully", () => {
    createManifest(VALID_MANIFEST_V2);
    const result = loadToolManifest(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(2);
    expect(result!.capabilityBlocks).toBeDefined();
    expect(result!.capabilityBlocks!.memory.tools).toEqual(["search_memory", "get_memory_detail"]);
    expect(result!.types.small.groups).toEqual(["memory"]);
    expect(result!.types.small.tools).toEqual(["speak", "yield"]);
  });

  it("should accept schemaVersion 1", () => {
    createManifest({ schemaVersion: 1, defaultType: "big", types: { big: { description: "test", tools: "*" } } });
    const result = loadToolManifest(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(1);
  });

  it("should accept schemaVersion 2", () => {
    createManifest({ schemaVersion: 2, defaultType: "big", types: { big: { description: "test", tools: "*" } } });
    const result = loadToolManifest(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(2);
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

  // capabilityBlocks 校验测试
  it("should return null when capabilityBlocks is not an object", () => {
    createManifest({
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: "invalid",
      types: { big: { description: "test", tools: "*" } },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when capabilityBlock is missing description", () => {
    createManifest({
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: { tools: ["search_memory"] },
      },
      types: { big: { description: "test", tools: "*" } },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when capabilityBlock tools is not an array", () => {
    createManifest({
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: { description: "test", tools: "*" },
      },
      types: { big: { description: "test", tools: "*" } },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when capabilityBlock tools contains non-string", () => {
    createManifest({
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: { description: "test", tools: [123] },
      },
      types: { big: { description: "test", tools: "*" } },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  // groups 校验测试
  it("should return null when groups is not an array", () => {
    createManifest({
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: { description: "test", tools: ["search_memory"] },
      },
      types: {
        big: { description: "test", tools: "*" },
        small: { description: "test", groups: "invalid", tools: ["speak"] },
      },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when groups references non-existent block", () => {
    createManifest({
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: { description: "test", tools: ["search_memory"] },
      },
      types: {
        big: { description: "test", tools: "*" },
        small: { description: "test", groups: ["nonexistent"], tools: ["speak"] },
      },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should return null when groups contains non-string", () => {
    createManifest({
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: { description: "test", tools: ["search_memory"] },
      },
      types: {
        big: { description: "test", tools: "*" },
        small: { description: "test", groups: [123], tools: ["speak"] },
      },
    });
    const result = loadToolManifest(TEST_DIR);
    expect(result).toBeNull();
  });

  it("should load manifest with valid groups references", () => {
    createManifest(VALID_MANIFEST_V2);
    const result = loadToolManifest(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.types.small.groups).toEqual(["memory"]);
  });

  it("should not include capabilityBlocks when not defined", () => {
    createManifest(VALID_MANIFEST);
    const result = loadToolManifest(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.capabilityBlocks).toBeUndefined();
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

  // v2 groups 展开测试
  it("should expand groups and merge with type tools", () => {
    const manifest: ToolManifest = {
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: {
          description: "记忆",
          tools: ["search_memory", "get_memory_detail"],
        },
        conversation: {
          description: "对话",
          tools: ["get_message", "list_messages"],
        },
      },
      types: {
        big: { description: "大獭", tools: "*" },
        small: {
          description: "小獭",
          groups: ["memory"],
          tools: ["speak", "yield"],
        },
      },
    };

    const result = getToolNamesFromManifest(manifest, "small", allToolNames);
    // groups 在前，type tools 在后
    expect(result).toEqual(["search_memory", "get_memory_detail", "speak", "yield"]);
  });

  it("should expand multiple groups in order", () => {
    const manifest: ToolManifest = {
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: {
          description: "记忆",
          tools: ["search_memory"],
        },
        conversation: {
          description: "对话",
          tools: ["get_message"],
        },
      },
      types: {
        big: { description: "大獭", tools: "*" },
        small: {
          description: "小獭",
          groups: ["memory", "conversation"],
          tools: ["speak"],
        },
      },
    };

    const result = getToolNamesFromManifest(manifest, "small", allToolNames);
    expect(result).toEqual(["search_memory", "get_message", "speak"]);
  });

  it("should dedupe tools from groups and type tools", () => {
    const manifest: ToolManifest = {
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: {
          description: "记忆",
          tools: ["search_memory", "speak"],
        },
      },
      types: {
        big: { description: "大獭", tools: "*" },
        small: {
          description: "小獭",
          groups: ["memory"],
          tools: ["speak", "yield"],
        },
      },
    };

    const result = getToolNamesFromManifest(manifest, "small", allToolNames);
    // speak 出现在 groups 和 type tools 中，只保留第一次出现
    expect(result).toEqual(["search_memory", "speak", "yield"]);
  });

  it("should handle type with groups but no tools", () => {
    const manifest: ToolManifest = {
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: {
          description: "记忆",
          tools: ["search_memory"],
        },
      },
      types: {
        big: { description: "大獭", tools: "*" },
        small: {
          description: "小獭",
          groups: ["memory"],
          tools: [],
        },
      },
    };

    const result = getToolNamesFromManifest(manifest, "small", allToolNames);
    expect(result).toEqual(["search_memory"]);
  });

  it("should handle type with tools but no groups", () => {
    const manifest: ToolManifest = {
      schemaVersion: 2,
      defaultType: "big",
      capabilityBlocks: {
        memory: {
          description: "记忆",
          tools: ["search_memory"],
        },
      },
      types: {
        big: { description: "大獭", tools: "*" },
        small: {
          description: "小獭",
          tools: ["speak", "yield"],
        },
      },
    };

    const result = getToolNamesFromManifest(manifest, "small", allToolNames);
    expect(result).toEqual(["speak", "yield"]);
  });

  it("should handle v1 manifest without capabilityBlocks", () => {
    const result = getToolNamesFromManifest(VALID_MANIFEST, "small", allToolNames);
    expect(result).toEqual(["speak", "yield", "search_memory"]);
  });
});
