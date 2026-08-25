import { execSync } from "node:child_process";
import type { Logger } from "@usecases/ports/logger";

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
  filesChanged: string[];
}

export interface GitLogCollectorOptions {
  since?: string;
  until?: string;
  maxCount?: number;
}

/**
 * Git 日志采集器（只读）。
 * 使用 child_process 执行 git log，采集提交历史。
 */
export class GitLogCollector {
  constructor(
    private readonly rootDir: string,
    private readonly logger: Logger,
  ) {}

  /**
   * 采集 git log。
   * @param options 采集选项（时间范围、最大数量）
   * @returns 提交列表
   */
  collect(options: GitLogCollectorOptions = {}): GitCommit[] {
    const { since, until, maxCount } = options;
    const args = [
      "log",
      "--pretty=format:%H|%an|%ai|%s",
      "--name-only",
    ];

    if (since) args.push(`--since=${since}`);
    if (until) args.push(`--until=${until}`);
    if (maxCount) args.push(`--max-count=${maxCount}`);

    try {
      const output = execSync(`git ${args.join(" ")}`, {
        cwd: this.rootDir,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 10, // 10MB
      });

      return this.parseGitLog(output);
    } catch (error) {
      this.logger.error("Failed to collect git log", error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * 解析 git log 输出。
   * 格式：hash|author|date|message\nfiles...
   */
  private parseGitLog(output: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const lines = output.split("\n").filter(line => line.trim());

    let currentCommit: Partial<GitCommit> | null = null;

    for (const line of lines) {
      // 提交头行：hash|author|date|message
      if (this.isCommitHeader(line)) {
        if (currentCommit?.hash) {
          commits.push(currentCommit as GitCommit);
        }
        currentCommit = this.parseCommitHeader(line);
      } else if (currentCommit && line.trim()) {
        // 文件变更行
        if (!currentCommit.filesChanged) {
          currentCommit.filesChanged = [];
        }
        currentCommit.filesChanged.push(line.trim());
      }
    }

    // 最后一个提交
    if (currentCommit?.hash) {
      commits.push(currentCommit as GitCommit);
    }

    return commits;
  }

  /**
   * 判断是否为提交头行。
   */
  private isCommitHeader(line: string): boolean {
    return line.includes("|") && !line.startsWith(" ");
  }

  /**
   * 解析提交头行。
   */
  private parseCommitHeader(line: string): Partial<GitCommit> {
    const [hash, author, date, ...messageParts] = line.split("|");
    return {
      hash: hash?.trim() || "",
      author: author?.trim() || "",
      date: date?.trim() || "",
      message: messageParts.join("|").trim(),
      filesChanged: [],
    };
  }
}
