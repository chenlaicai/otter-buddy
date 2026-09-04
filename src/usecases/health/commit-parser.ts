/**
 * CommitParser: 从 commit message 中提取结构化信息
 * 
 * 支持的格式：
 * 1. 标准格式：[F20260824rhib][health][New Feature] 标题 (#409)
 *    类型白名单 5 种（New Feature/Feature Update/BugFix/Refactor/Design，
 *    与 commit-convention.md、.githooks/commit-msg 对齐，#671；
 *    FeatureUpdate 无空格笔误归一化为 Feature Update，#425 建议 2）
 * 2. 不合规格式：init/Revert/R 文档头等 → skip-with-reason；
 *    三段结构完整但类型未识别 → unrecognized_change_type（#425 发现 7）；
 *    缺类型段等格式问题 → non_standard_format
 * 
 * 口径说明（来自特性文档 F20260824rhib）：
 * - F 前缀：249/259（96.1%）
 * - 严格三段格式：182/259（70.3%）—— 模块段仅允许纯字母（不含连字符）
 *
 * FID 形态契约（#667）：F/R ID 的日期段与后缀段正则源自单一真相源
 * src/entities/document/fid-format.ts（排除 0/1/l/o 的旧字母表已废弃——
 * 仓库从无该约定，frontmatter-validator 与 ID 生成现状均为全小写字母数字，
 * 旧正则致 5 个存量特性 commit 被漏判 no_f_prefix，详见 issue #667）
 */

export interface ParsedCommit {
  /** commit SHA */
  sha: string;
  /** 完整 commit message */
  message: string;
  /** 提取的 F 文档 ID（如 F20260824rhib），无则为 null */
  featureId: string | null;
  /** 提取的模块名（如 agent、skills），无则为 null */
  module: string | null;
  /** 提取的变更类型（如 New Feature、BugFix），无则为 null */
  changeType: string | null;
  /** 提取的 PR 号（如 409），无则为 null */
  prNumber: number | null;
  /** 是否为合规 commit */
  isCompliant: boolean;
  /** 不合规原因（仅当 isCompliant=false 时有值） */
  skipReason?: string;
}

import { FID_DATE_SEGMENT, FID_SUFFIX_SEGMENT } from "@entities/document/fid-format";

/**
 * 类型白名单：真相源为 commit-convention.md Type Tags 表与 .githooks/commit-msg（#671）。
 * parser 原白名单仅 3 种（缺 Refactor/Design），与 #427（hook 补录）/ #432（文档删
 * Feature 历史别名）两次收口漂移，致存量真实特性 commit 被误判 non_standard_format。
 */
const CHANGE_TYPE_WHITELIST = ["New Feature", "Feature Update", "BugFix", "Refactor", "Design"] as const;

/** 白名单 → 正则类型段（空格兼容无空格笔误：Feature Update → Feature ?Update，#425 建议 2） */
const TYPE_PATTERN = CHANGE_TYPE_WHITELIST.map((t) => t.replace(" ", " ?")).join("|");

/** FeatureUpdate 笔误归一化（#425 建议 2）：无空格形态归一为标准类型名 */
function normalizeChangeType(raw: string): string {
  return raw === "FeatureUpdate" ? "Feature Update" : raw;
}

/** 标准三段格式正则：[FID][module][type]（#667：FID 段源自 fid-format.ts 单一真相源；#671：类型段由白名单生成） */
const STANDARD_FORMAT_REGEX = new RegExp(
  `^\\[F(${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT})\\]\\[([a-z][a-z-]*)\\]\\[(${TYPE_PATTERN})\\]`
);

/** 三段结构探测正则（#425 发现 7）：类型段存在但值任意——用于区分「类型未识别」与「格式不合规」；捕获组结构与 STANDARD_FORMAT_REGEX 对齐（1=FID，2=module，3=类型） */
const STRUCTURED_TYPE_SEGMENT_REGEX = new RegExp(
  `^\\[F(${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT})\\]\\[([a-z][a-z-]*)\\]\\[([^\\]]+)\\]`
);

/** PR 号正则：(#123) */
const PR_NUMBER_REGEX = /\(#(\d+)\)/;

/**
 * 解析单个 commit message
 * @param sha commit SHA
 * @param message commit message（完整内容）
 * @returns 解析结果
 */
export function parseCommit(sha: string, message: string): ParsedCommit {
  const firstLine = message.split('\n')[0]?.trim() ?? '';
  const skipReason = detectSkipReason(firstLine);
  
  if (skipReason) {
    return createNonCompliantResult(sha, message, skipReason);
  }

  // 尝试匹配标准格式（类型段白名单命中，含 FeatureUpdate 笔误归一化）
  const standardMatch = firstLine.match(STANDARD_FORMAT_REGEX);
  if (standardMatch) {
    return createCompliantResult(sha, message, standardMatch, firstLine);
  }

  // 三段结构完整但类型未识别（#425 发现 7）：与纯格式不合规区分，
  // 如 [Feature]/[Enhancement]/[Tests]（Feature 是历史别名，#432 起不再收录）
  const structuredTypeMatch = firstLine.match(STRUCTURED_TYPE_SEGMENT_REGEX);
  if (structuredTypeMatch) {
    return createFPrefixResult(sha, message, structuredTypeMatch, firstLine, { skipReason: 'unrecognized_change_type', module: structuredTypeMatch[2] });
  }

  // 非标准格式但有 F 前缀（缺类型段等格式问题）
  const fPrefixMatch = firstLine.match(new RegExp(`^\\[F(${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT})\\]`));
  if (fPrefixMatch) {
    return createFPrefixResult(sha, message, fPrefixMatch, firstLine);
  }

  // 完全不合规
  return createNonCompliantResult(sha, message, 'no_f_prefix');
}

/** 检测是否应跳过 */
function detectSkipReason(firstLine: string): string | null {
  if (firstLine.startsWith('Merge ')) return 'merge_commit';
  if (firstLine.startsWith('fixup!')) return 'fixup_commit';
  if (firstLine.startsWith('init:') || firstLine.startsWith('Initial commit')) return 'init_commit';
  if (firstLine.startsWith('Revert ')) return 'revert_commit';
  if (firstLine.match(new RegExp(`^\\[R${FID_DATE_SEGMENT}${FID_SUFFIX_SEGMENT}\\]`))) return 'research_document';
  return null;
}

/** 创建不合规结果 */
function createNonCompliantResult(sha: string, message: string, skipReason: string): ParsedCommit {
  return { sha, message, featureId: null, module: null, changeType: null, prNumber: null, isCompliant: false, skipReason };
}

/** 创建标准格式合规结果 */
function createCompliantResult(
  sha: string,
  message: string,
  match: RegExpMatchArray,
  firstLine: string
): ParsedCommit {
  const featureId = `F${match[1]}`;
  const module = match[2];
  const changeType = normalizeChangeType(match[3]);
  const prMatch = firstLine.match(PR_NUMBER_REGEX);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
  return { sha, message, featureId, module, changeType, prNumber, isCompliant: true };
}

/** 创建 F 前缀非标准格式结果（skipReason 区分 unrecognized_change_type 与 non_standard_format，#671） */
function createFPrefixResult(
  sha: string,
  message: string,
  match: RegExpMatchArray,
  firstLine: string,
  opts: { skipReason?: string; module?: string | null } = {}
): ParsedCommit {
  const featureId = `F${match[1]}`;
  const prMatch = firstLine.match(PR_NUMBER_REGEX);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
  return { sha, message, featureId, module: opts.module ?? null, changeType: null, prNumber, isCompliant: false, skipReason: opts.skipReason ?? 'non_standard_format' };
}

/**
 * 批量解析 commit messages
 * @param commits commit 列表 [{sha, message}]
 * @returns 解析结果列表
 */
export function parseCommits(commits: Array<{ sha: string; message: string }>): ParsedCommit[] {
  return commits.map(({ sha, message }) => parseCommit(sha, message));
}
