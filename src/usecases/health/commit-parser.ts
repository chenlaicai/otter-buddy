/**
 * CommitParser: 从 commit message 中提取结构化信息
 * 
 * 支持的格式：
 * 1. 标准格式：[F20260824rhib][health][New Feature] 标题 (#409)
 * 2. 不合规格式：init/Revert/R 文档头等 → skip-with-reason
 * 
 * 口径说明（来自特性文档 F20260824rhib）：
 * - F 前缀：249/259（96.1%）
 * - 严格三段格式：182/259（70.3%）—— 模块段仅允许纯字母（不含连字符）
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

/** 标准三段格式正则：[FID][module][type] */
const STANDARD_FORMAT_REGEX = /^\[F(\d{8}[a-kmnp-z][2-9a-kmnp-z]{3,9})\]\[([a-z][a-z-]*)\]\[(New Feature|BugFix|Feature Update)\]/;

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

  // 尝试匹配标准格式
  const standardMatch = firstLine.match(STANDARD_FORMAT_REGEX);
  if (standardMatch) {
    return createCompliantResult(sha, message, standardMatch, firstLine);
  }

  // 非标准格式但有 F 前缀
  const fPrefixMatch = firstLine.match(/^\[F(\d{8}[a-kmnp-z][2-9a-kmnp-z]{3,9})\]/);
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
  if (firstLine.match(/^\[R\d{8}[a-kmnp-z][2-9a-kmnp-z]{3,9}\]/)) return 'research_document';
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
  const changeType = match[3];
  const prMatch = firstLine.match(PR_NUMBER_REGEX);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
  return { sha, message, featureId, module, changeType, prNumber, isCompliant: true };
}

/** 创建 F 前缀非标准格式结果 */
function createFPrefixResult(
  sha: string,
  message: string,
  match: RegExpMatchArray,
  firstLine: string
): ParsedCommit {
  const featureId = `F${match[1]}`;
  const prMatch = firstLine.match(PR_NUMBER_REGEX);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
  return { sha, message, featureId, module: null, changeType: null, prNumber, isCompliant: false, skipReason: 'non_standard_format' };
}

/**
 * 批量解析 commit messages
 * @param commits commit 列表 [{sha, message}]
 * @returns 解析结果列表
 */
export function parseCommits(commits: Array<{ sha: string; message: string }>): ParsedCommit[] {
  return commits.map(({ sha, message }) => parseCommit(sha, message));
}
