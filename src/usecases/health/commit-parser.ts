import type { Logger } from "@usecases/ports/logger";

export interface ParsedCommit {
  fid: string | null;
  module: string | null;
  changeType: string | null;
  prNumber: number | null;
  isValid: boolean;
  skipReason?: string;
}

/**
 * 提交消息解析器。
 * 从 commit message 中提取 FID、module、changeType、PR号。
 */
export class CommitParser {
  // 严格三段格式正则：[FID][module][changeType] message
  // changeType 允许空格和大小写，如 "New Feature"、"Bug Fix"
  private readonly STRICT_PATTERN = /^\[([A-Z]\d{8}[a-z0-9]+)\]\[([a-z]+)\]\[([a-zA-Z\s_]+)\]\s*(.+)$/i;

  // 宽松格式正则：[FID] message 或 FID message
  private readonly LOOSE_PATTERN = /^([A-Z]\d{8}[a-z0-9]+)\s+(.+)$/i;

  // PR 号提取正则：(#123) 或 #123
  private readonly PR_PATTERN = /\(#(\d+)\)|#(\d+)/;

  // 不合规分支处理
  private readonly SKIP_PATTERNS = [
    { pattern: /^Revert\s/i, reason: "revert_commit" },
    { pattern: /^init\s/i, reason: "init_commit" },
    { pattern: /^Merge\s/i, reason: "merge_commit" },
    { pattern: /^[A-Z]\d{8}[a-z0-9]+\s*$/, reason: "fid_only_no_message" },
  ];

  constructor(private readonly logger: Logger) {}

  /**
   * 解析提交消息。
   * @param message 提交消息
   * @returns 解析结果
   */
  parse(message: string): ParsedCommit {
    // 检查是否应该跳过
    const skipResult = this.checkSkipPatterns(message);
    if (skipResult) {
      return skipResult;
    }

    // 尝试严格三段格式
    const strictMatch = message.match(this.STRICT_PATTERN);
    if (strictMatch) {
      const fid = strictMatch[1] || null;
      const module = strictMatch[2] || null;
      const changeType = strictMatch[3] || null;
      const prNumber = this.extractPrNumber(message);

      return {
        fid,
        module,
        changeType,
        prNumber,
        isValid: true,
      };
    }

    // 尝试宽松格式
    const looseMatch = message.match(this.LOOSE_PATTERN);
    if (looseMatch) {
      const fid = looseMatch[1] || null;
      const prNumber = this.extractPrNumber(message);

      return {
        fid,
        module: null,
        changeType: null,
        prNumber,
        isValid: true,
        skipReason: "loose_format",
      };
    }

    // 无法解析
    return {
      fid: null,
      module: null,
      changeType: null,
      prNumber: null,
      isValid: false,
      skipReason: "unparseable",
    };
  }

  /**
   * 批量解析提交消息。
   * @param messages 提交消息列表
   * @returns 解析结果列表
   */
  parseBatch(messages: string[]): ParsedCommit[] {
    return messages.map(message => this.parse(message));
  }

  /**
   * 检查是否应该跳过。
   */
  private checkSkipPatterns(message: string): ParsedCommit | null {
    for (const { pattern, reason } of this.SKIP_PATTERNS) {
      if (pattern.test(message)) {
        return {
          fid: null,
          module: null,
          changeType: null,
          prNumber: null,
          isValid: false,
          skipReason: reason,
        };
      }
    }
    return null;
  }

  /**
   * 提取 PR 号。
   */
  private extractPrNumber(message: string): number | null {
    const match = message.match(this.PR_PATTERN);
    if (match) {
      const prNumber = parseInt(match[1] || match[2] || "", 10);
      return isNaN(prNumber) ? null : prNumber;
    }
    return null;
  }
}
