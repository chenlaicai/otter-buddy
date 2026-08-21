#!/usr/bin/env node
/**
 * F20260820a4rt: otter-type 工具路由 manifest 校验（commit-time gate）。
 * F20260821a5cb: 新增 capabilityBlocks / groups 校验。
 *
 * 校验项：
 * 1. schemaVersion 必须为 1 或 2
 * 2. defaultType 必须指向 manifest 中已定义的类型
 * 3. DB otter_type CHECK 约束中的类型必须在 manifest 中有对应条目
 * 4. manifest 中引用的工具名必须在 tool-factory.ts 中存在
 * 5. capabilityBlocks 结构校验（v2+）
 * 6. groups 引用校验（引用的块名必须在 capabilityBlocks 中存在）
 * 7. capabilityBlocks 内工具名存在性校验
 *
 * 退出码：0 通过 / 1 有错误。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const MANIFEST_PATH = path.join(root, "config/tool-manifest.json");
const MIGRATION_PATH = path.join(root, "src/frameworks/db/migration.ts");

const SUPPORTED_SCHEMA_VERSIONS = [1, 2];

let errors = 0;

function error(msg) { errors++; console.error(`✗ ${msg}`); }

/** 读取并解析 manifest */
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    error(`manifest 文件不存在: ${MANIFEST_PATH}`);
    return null;
  }

  let raw;
  try {
    raw = fs.readFileSync(MANIFEST_PATH, "utf-8");
  } catch (err) {
    error(`读取 manifest 失败: ${err.message}`);
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    error(`manifest JSON 解析失败: ${err.message}`);
    return null;
  }
}

/** 从 migration.ts 解析 CHECK 约束中的 otter_type 列表 */
function parseMigrationCheckConstraint() {
  if (!fs.existsSync(MIGRATION_PATH)) {
    error(`migration 文件不存在: ${MIGRATION_PATH}`);
    return null;
  }

  const content = fs.readFileSync(MIGRATION_PATH, "utf-8");

  // 匹配 CHECK(otter_type IN ('big', 'small')) 模式
  const match = content.match(/CHECK\(otter_type\s+IN\s*\(([^)]+)\)\)/i);
  if (!match) {
    error("migration 中未找到 CHECK(otter_type IN (...)) 约束");
    return null;
  }

  const typesStr = match[1];
  const types = typesStr
    .split(",")
    .map(s => s.trim().replace(/['"]/g, ""))
    .filter(s => s.length > 0);

  return types;
}

/** 校验 manifest */
function validateManifest(manifest) {
  // 1. schemaVersion
  if (typeof manifest.schemaVersion !== "number" || !SUPPORTED_SCHEMA_VERSIONS.includes(manifest.schemaVersion) || !Number.isInteger(manifest.schemaVersion)) {
    error(`schemaVersion 必须为 ${SUPPORTED_SCHEMA_VERSIONS.join(" 或 ")} 的正整数，实际为 ${manifest.schemaVersion}`);
  }

  // 2. defaultType
  if (typeof manifest.defaultType !== "string" || manifest.defaultType.length === 0) {
    error("defaultType 必须为非空字符串");
  } else if (!(manifest.defaultType in manifest.types)) {
    error(`defaultType "${manifest.defaultType}" 在 types 中未定义`);
  }

  // 3. capabilityBlocks（v2+ 可选）
  if (manifest.capabilityBlocks !== undefined) {
    validateCapabilityBlocks(manifest.capabilityBlocks);
  }

  // 4. types 结构
  if (typeof manifest.types !== "object" || manifest.types === null) {
    error("types 必须为对象");
    return;
  }

  for (const [typeName, typeConfig] of Object.entries(manifest.types)) {
    if (typeof typeConfig !== "object" || typeConfig === null) {
      error(`types.${typeName} 必须为对象`);
      continue;
    }

    if (typeof typeConfig.description !== "string") {
      error(`types.${typeName}.description 必须为字符串`);
    }

    // 校验 groups（可选）
    if (typeConfig.groups !== undefined) {
      validateGroups(typeName, typeConfig.groups, manifest.capabilityBlocks);
    }

    if (typeConfig.tools !== "*" && !Array.isArray(typeConfig.tools)) {
      error(`types.${typeName}.tools 必须为 "*" 或数组`);
    }

    if (Array.isArray(typeConfig.tools)) {
      for (const tool of typeConfig.tools) {
        if (typeof tool !== "string") {
          error(`types.${typeName}.tools 中包含非字符串元素: ${tool}`);
        }
      }
    }
  }
}

/** 校验 capabilityBlocks 结构 */
function validateCapabilityBlocks(blocks) {
  if (typeof blocks !== "object" || blocks === null) {
    error("capabilityBlocks 必须为对象");
    return;
  }

  for (const [blockName, blockConfig] of Object.entries(blocks)) {
    if (typeof blockConfig !== "object" || blockConfig === null) {
      error(`capabilityBlocks.${blockName} 必须为对象`);
      continue;
    }

    if (typeof blockConfig.description !== "string") {
      error(`capabilityBlocks.${blockName}.description 必须为字符串`);
    }

    if (!Array.isArray(blockConfig.tools)) {
      error(`capabilityBlocks.${blockName}.tools 必须为数组`);
      continue;
    }

    for (const tool of blockConfig.tools) {
      if (typeof tool !== "string") {
        error(`capabilityBlocks.${blockName}.tools 中包含非字符串元素: ${tool}`);
      }
    }
  }
}

/** 校验 groups 引用 */
function validateGroups(typeName, groups, blocks) {
  if (!Array.isArray(groups)) {
    error(`types.${typeName}.groups 必须为数组`);
    return;
  }

  for (const group of groups) {
    if (typeof group !== "string") {
      error(`types.${typeName}.groups 中包含非字符串元素: ${group}`);
      continue;
    }

    // Why: groups 引用的块名必须在 capabilityBlocks 中定义
    if (!blocks || typeof blocks !== "object" || !(group in blocks)) {
      error(`types.${typeName}.groups 引用了不存在的能力块 "${group}"`);
    }
  }
}

/** 从 src/interface-adapters/agent-runtime/tools/*.ts 解析已注册的工具名列表 */
function parseRegisteredTools() {
  const toolsDir = path.join(root, "src/interface-adapters/agent-runtime/tools");
  if (!fs.existsSync(toolsDir)) {
    error(`tools 目录不存在: ${toolsDir}`);
    return null;
  }

  const tools = new Set();
  const files = fs.readdirSync(toolsDir).filter(f => f.endsWith(".ts"));

  for (const file of files) {
    const content = fs.readFileSync(path.join(toolsDir, file), "utf-8");
    // 匹配 name: "tool_name" 模式（排除参数定义中的 name 字段）
    const matches = content.matchAll(/^\s+name:\s*"([a-z_]+)",?$/gm);
    for (const match of matches) {
      tools.add(match[1]);
    }
  }

  return tools;
}

/** 校验 manifest 中引用的工具名是否在 tool-factory.ts 中存在 */
function validateToolNames(manifest, registeredTools) {
  if (!registeredTools) return;

  // 校验 types 中的工具名
  for (const [typeName, typeConfig] of Object.entries(manifest.types)) {
    if (typeConfig.tools === "*") continue;

    for (const tool of typeConfig.tools) {
      if (!registeredTools.has(tool)) {
        error(`types.${typeName}.tools 中的工具 "${tool}" 在 tool-factory.ts 中未注册`);
      }
    }
  }

  // 校验 capabilityBlocks 中的工具名
  if (manifest.capabilityBlocks) {
    for (const [blockName, blockConfig] of Object.entries(manifest.capabilityBlocks)) {
      for (const tool of blockConfig.tools) {
        if (!registeredTools.has(tool)) {
          error(`capabilityBlocks.${blockName}.tools 中的工具 "${tool}" 在 tool-factory.ts 中未注册`);
        }
      }
    }
  }
}

/** 校验 manifest 类型与 DB 约束一致性 */
function validateTypeConsistency(manifest, dbTypes) {
  if (!dbTypes) return;

  const manifestTypes = new Set(Object.keys(manifest.types));

  // DB 约束中的类型必须在 manifest 中有对应条目
  for (const dbType of dbTypes) {
    if (!manifestTypes.has(dbType)) {
      error(`DB CHECK 约束中的类型 "${dbType}" 在 manifest 中未定义`);
    }
  }

  // manifest 中的类型是否在 DB 约束中（警告，因为 DB 可能还没更新）
  for (const manifestType of manifestTypes) {
    if (!dbTypes.includes(manifestType)) {
      console.warn(`⚠ manifest 类型 "${manifestType}" 不在 DB CHECK 约束中（可能是新增类型，需更新 migration）`);
    }
  }
}

// 主流程
const manifest = loadManifest();
if (!manifest) {
  process.exit(1);
}

validateManifest(manifest);

const dbTypes = parseMigrationCheckConstraint();
if (manifest && dbTypes) {
  validateTypeConsistency(manifest, dbTypes);
}

// 工具名存在性检查
const registeredTools = parseRegisteredTools();
if (manifest && registeredTools) {
  validateToolNames(manifest, registeredTools);
}

if (errors > 0) {
  console.error(`\n✗ ${errors} 个错误，lint 失败`);
  process.exit(1);
} else {
  console.log("✓ tool-manifest lint 通过");
}
