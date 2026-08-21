/**
 * otter-type 级声明式工具路由 manifest 加载器。
 *
 * F20260820a4rt: 将硬编码的工具白名单改为声明式配置，
 * 新增/调整 otter 类型只需修改 config/tool-manifest.json，不改代码。
 *
 * F20260821a5cb: 新增 capabilityBlocks（能力块）支持。
 * types 可通过 groups 字段引用命名工具组，loader 自动展开合并。
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/** 能力块定义：一组命名的工具 */
export interface CapabilityBlock {
  description: string;
  tools: string[];
}

/** manifest 中单个 otter 类型的配置 */
export interface ToolManifestType {
  description: string;
  /** 引用的能力块名称列表（可选） */
  groups?: string[];
  /** 工具名列表，"*" 表示全部工具 */
  tools: string[] | "*";
}

/** manifest 配置文件结构 */
export interface ToolManifest {
  schemaVersion: number;
  defaultType: string;
  /** 能力块定义（v2+，可选） */
  capabilityBlocks?: Record<string, CapabilityBlock>;
  types: Record<string, ToolManifestType>;
}

/** manifest 文件路径（相对于项目根目录） */
const MANIFEST_RELATIVE_PATH = "config/tool-manifest.json";

/** 支持的 schema 版本范围 */
const SUPPORTED_SCHEMA_VERSIONS = [1, 2];

/**
 * 加载 manifest 文件。
 *
 * 错误处理边界：
 * 1. 文件不存在 → 返回 null + warn 日志
 * 2. JSON 解析失败（语法错误）→ 返回 null + error 日志
 * 3. schema 不合规（缺字段/类型错误/版本不匹配）→ 返回 null + error 日志
 *
 * 调用方收到 null 后 fallback 到硬编码默认值。
 */
export function loadToolManifest(
  projectRoot: string,
  logger?: { warn: (msg: string) => void; error: (msg: string) => void },
): ToolManifest | null {
  const manifestPath = resolve(projectRoot, MANIFEST_RELATIVE_PATH);

  // 场景 1: 文件不存在
  if (!existsSync(manifestPath)) {
    logger?.warn(`[tool-manifest] manifest 文件不存在: ${manifestPath}，fallback 到硬编码默认值`);
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (err) {
    logger?.error(`[tool-manifest] 读取 manifest 文件失败: ${err instanceof Error ? err.message : String(err)}，fallback 到硬编码默认值`);
    return null;
  }

  // 场景 2: JSON 解析失败
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger?.error(`[tool-manifest] manifest JSON 解析失败: ${err instanceof Error ? err.message : String(err)}，fallback 到硬编码默认值`);
    return null;
  }

  // 场景 3: schema 不合规
  const validated = validateManifest(parsed, logger);
  if (!validated) {
    return null;
  }

  return validated;
}

/**
 * 校验 manifest schema。
 * 失败时返回 null + error 日志。
 */
function validateManifest(
  parsed: unknown,
  logger?: { error: (msg: string) => void },
): ToolManifest | null {
  if (typeof parsed !== "object" || parsed === null) {
    logger?.error("[tool-manifest] manifest 根节点必须是对象，fallback 到硬编码默认值");
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  const schemaError = validateSchemaVersion(obj.schemaVersion, logger);
  if (schemaError) return null;

  const defaultTypeError = validateDefaultType(obj.defaultType, obj.types, logger);
  if (defaultTypeError) return null;

  // v2+: 校验 capabilityBlocks（可选字段）
  const blocks = obj.capabilityBlocks as Record<string, CapabilityBlock> | undefined;
  if (obj.capabilityBlocks !== undefined) {
    const blocksError = validateCapabilityBlocks(obj.capabilityBlocks, logger);
    if (blocksError) return null;
  }

  const typesError = validateTypes(obj.types, blocks, logger);
  if (typesError) return null;

  const types = obj.types as Record<string, ToolManifestType>;

  return {
    schemaVersion: obj.schemaVersion as number,
    defaultType: obj.defaultType as string,
    ...(blocks ? { capabilityBlocks: blocks } : {}),
    types,
  };
}

function validateSchemaVersion(
  schemaVersion: unknown,
  logger?: { error: (msg: string) => void },
): string | null {
  if (typeof schemaVersion !== "number" || !SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    logger?.error(`[tool-manifest] manifest schemaVersion 必须为 ${SUPPORTED_SCHEMA_VERSIONS.join(" 或 ")}，实际为 ${schemaVersion}，fallback 到硬编码默认值`);
    return "error";
  }
  return null;
}

function validateDefaultType(
  defaultType: unknown,
  types: unknown,
  logger?: { error: (msg: string) => void },
): string | null {
  if (typeof defaultType !== "string" || defaultType.length === 0) {
    logger?.error("[tool-manifest] manifest defaultType 必须为非空字符串，fallback 到硬编码默认值");
    return "error";
  }

  if (typeof types !== "object" || types === null) {
    logger?.error("[tool-manifest] manifest types 必须为对象，fallback 到硬编码默认值");
    return "error";
  }

  if (!(defaultType in (types as Record<string, unknown>))) {
    logger?.error(`[tool-manifest] defaultType "${defaultType}" 在 types 中未定义，fallback 到硬编码默认值`);
    return "error";
  }

  return null;
}

/**
 * 校验 capabilityBlocks 结构。
 * v2+ 可选字段。校验：每个 block 必须有 description (string) 和 tools (string[])。
 */
function validateCapabilityBlocks(
  blocks: unknown,
  logger?: { error: (msg: string) => void },
): string | null {
  if (typeof blocks !== "object" || blocks === null) {
    logger?.error("[tool-manifest] capabilityBlocks 必须为对象，fallback 到硬编码默认值");
    return "error";
  }

  for (const [blockName, blockConfig] of Object.entries(blocks as Record<string, unknown>)) {
    const blockError = validateCapabilityBlockConfig(blockName, blockConfig, logger);
    if (blockError) return "error";
  }

  return null;
}

function validateCapabilityBlockConfig(
  blockName: string,
  blockConfig: unknown,
  logger?: { error: (msg: string) => void },
): string | null {
  if (typeof blockConfig !== "object" || blockConfig === null) {
    logger?.error(`[tool-manifest] capabilityBlocks.${blockName} 必须为对象，fallback 到硬编码默认值`);
    return "error";
  }

  const bc = blockConfig as Record<string, unknown>;

  if (typeof bc.description !== "string") {
    logger?.error(`[tool-manifest] capabilityBlocks.${blockName}.description 必须为字符串，fallback 到硬编码默认值`);
    return "error";
  }

  if (!Array.isArray(bc.tools)) {
    logger?.error(`[tool-manifest] capabilityBlocks.${blockName}.tools 必须为数组，fallback 到硬编码默认值`);
    return "error";
  }

  for (const tool of bc.tools) {
    if (typeof tool !== "string") {
      logger?.error(`[tool-manifest] capabilityBlocks.${blockName}.tools 中包含非字符串元素，fallback 到硬编码默认值`);
      return "error";
    }
  }

  return null;
}

function validateTypes(
  types: unknown,
  blocks: Record<string, CapabilityBlock> | undefined,
  logger?: { error: (msg: string) => void },
): string | null {
  if (typeof types !== "object" || types === null) {
    logger?.error("[tool-manifest] manifest types 必须为对象，fallback 到硬编码默认值");
    return "error";
  }

  for (const [typeName, typeConfig] of Object.entries(types as Record<string, unknown>)) {
    const typeError = validateTypeConfig(typeName, typeConfig, blocks, logger);
    if (typeError) return "error";
  }

  return null;
}

function validateTypeConfig(
  typeName: string,
  typeConfig: unknown,
  blocks: Record<string, CapabilityBlock> | undefined,
  logger?: { error: (msg: string) => void },
): string | null {
  if (typeof typeConfig !== "object" || typeConfig === null) {
    logger?.error(`[tool-manifest] types.${typeName} 必须为对象，fallback 到硬编码默认值`);
    return "error";
  }

  const tc = typeConfig as Record<string, unknown>;

  if (typeof tc.description !== "string") {
    logger?.error(`[tool-manifest] types.${typeName}.description 必须为字符串，fallback 到硬编码默认值`);
    return "error";
  }

  // 校验 groups（可选）
  if (tc.groups !== undefined) {
    const groupsError = validateGroups(typeName, tc.groups, blocks, logger);
    if (groupsError) return "error";
  }

  return validateTools(typeName, tc.tools, logger);
}

/**
 * 校验 groups 字段。
 * 每个 group 名称必须在 capabilityBlocks 中存在。
 */
function validateGroups(
  typeName: string,
  groups: unknown,
  blocks: Record<string, CapabilityBlock> | undefined,
  logger?: { error: (msg: string) => void },
): string | null {
  if (!Array.isArray(groups)) {
    logger?.error(`[tool-manifest] types.${typeName}.groups 必须为数组，fallback 到硬编码默认值`);
    return "error";
  }

  for (const group of groups) {
    if (typeof group !== "string") {
      logger?.error(`[tool-manifest] types.${typeName}.groups 中包含非字符串元素，fallback 到硬编码默认值`);
      return "error";
    }

    // Why: groups 引用的块名必须在 capabilityBlocks 中定义，否则无法展开
    if (!blocks || !(group in blocks)) {
      logger?.error(`[tool-manifest] types.${typeName}.groups 引用了不存在的能力块 "${group}"，fallback 到硬编码默认值`);
      return "error";
    }
  }

  return null;
}

function validateTools(
  typeName: string,
  tools: unknown,
  logger?: { error: (msg: string) => void },
): string | null {
  if (tools !== "*" && !Array.isArray(tools)) {
    logger?.error(`[tool-manifest] types.${typeName}.tools 必须为 "*" 或数组，fallback 到硬编码默认值`);
    return "error";
  }

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (typeof tool !== "string") {
        logger?.error(`[tool-manifest] types.${typeName}.tools 中包含非字符串元素，fallback 到硬编码默认值`);
        return "error";
      }
    }
  }

  return null;
}

/**
 * 从 manifest 查询指定 otter 类型的工具名列表。
 *
 * 展开逻辑（v2+）：
 * 1. 收集 groups 引用的 capabilityBlocks 的 tools
 * 2. 与 type 自身的 tools 合并
 * 3. dedupe（保序：groups 在前，type tools 在后）
 *
 * @param manifest - 已加载的 manifest 配置
 * @param otterType - otter 类型名
 * @param allToolNames - 当前 session 可用的全部工具名，"*" 展开时使用。
 *   由调用方（pi-session-factory）从已注册工具列表传入。
 * @returns 工具名列表
 */
export function getToolNamesFromManifest(
  manifest: ToolManifest,
  otterType: string,
  allToolNames: string[],
): string[] {
  const typeConfig = manifest.types[otterType] ?? manifest.types[manifest.defaultType];

  if (!typeConfig) {
    // fallback 到全部工具（防御性编程）
    return allToolNames;
  }

  if (typeConfig.tools === "*") {
    return allToolNames;
  }

  // Why: groups 在前、type tools 在后，合并去重
  const expanded: string[] = [];

  if (typeConfig.groups && manifest.capabilityBlocks) {
    for (const groupName of typeConfig.groups) {
      const block = manifest.capabilityBlocks[groupName];
      if (block) {
        expanded.push(...block.tools);
      }
    }
  }

  expanded.push(...typeConfig.tools);

  // dedupe preserving order（groups 优先）
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of expanded) {
    if (!seen.has(tool)) {
      seen.add(tool);
      result.push(tool);
    }
  }

  return result;
}
