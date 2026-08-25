/**
 * GitLogCollector: 从 git log 中采集 commit 信息（只读操作）
 * 
 * 使用 child_process 执行 git log，提取 commit SHA 和 message。
 * 不修改任何 git 数据，仅读取。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommit {
  sha: string;
  message: string;
}

/**
 * 从 git log 中采集 commit 信息
 * @param repoPath 仓库根目录路径
 * @param options 可选参数
 * @param options.since 起始日期（ISO 格式），默认不限制
 * @param options.until 结束日期（ISO 格式），默认不限制
 * @param options.maxCount 最大 commit 数，默认不限制
 * @returns commit 列表
 */
export async function collectGitLog(
  repoPath: string,
  options?: {
    since?: string;
    until?: string;
    maxCount?: number;
  }
): Promise<GitCommit[]> {
  const args = [
    "log",
    "--format=%H %s",  // SHA + 第一行 message
  ];

  if (options?.since) {
    args.push(`--since=${options.since}`);
  }
  if (options?.until) {
    args.push(`--until=${options.until}`);
  }
  if (options?.maxCount) {
    args.push(`--max-count=${options.maxCount}`);
  }

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,  // 10MB buffer
    });

    const commits: GitCommit[] = [];
    const lines = stdout.trim().split("\n").filter(line => line.length > 0);

    for (const line of lines) {
      const spaceIndex = line.indexOf(" ");
      if (spaceIndex === -1) continue;

      const sha = line.substring(0, spaceIndex);
      const message = line.substring(spaceIndex + 1);
      commits.push({ sha, message });
    }

    return commits;
  } catch (error) {
    throw new Error(`Failed to collect git log: ${error}`, { cause: error });
  }
}

/** 带文件变更列表的 commit（文件热点/模块热区计算用） */
export interface GitCommitWithFiles {
  sha: string;
  message: string;
  /** ISO 8601 作者日期（%aI，特性链时间序/信号窗口判定用） */
  date: string;
  filesChanged: string[];
}

/**
 * 批量采集 commit + 变更文件列表（单次 git log，避免逐 commit 子进程）。
 * 用 %x1f（字段分隔）/ %x1e（记录分隔）标记，规避 message 含 | 或空行的歧义。
 * merge commit 默认不列文件（git log 对 merge 不做 diff），filesChanged 为空数组。
 */
export async function collectGitLogWithFiles(
  repoPath: string,
  options?: {
    since?: string;
    until?: string;
    maxCount?: number;
    /** 统计基准分支（默认 main）——RHI 语义是“仓库健康”，
     *  不指定 ref 时 git log 取 HEAD，在 feature 分支上运行会得到分支线性历史，
     *  bugfix 比率等指标不可复现（PR #417 对抗审视发现 2） */
    ref?: string;
  }
): Promise<GitCommitWithFiles[]> {
  const args = [
    "log",
    options?.ref ?? "main",
    // %aI=ISO 作者日期：链构建/信号窗口的时间基准（不用 %cI 提交日期——rebase 会改写）
    "--format=%x1e%H%x1f%aI%x1f%s",
    "--name-only",
  ];

  if (options?.since) args.push(`--since=${options.since}`);
  if (options?.until) args.push(`--until=${options.until}`);
  if (options?.maxCount) args.push(`--max-count=${options.maxCount}`);

  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024,
  });

  return parseLogWithFiles(stdout);
}

/** 解析 `git log --format=%x1e%H%x1f%aI%x1f%s --name-only` 输出 */
function parseLogWithFiles(stdout: string): GitCommitWithFiles[] {
  const commits: GitCommitWithFiles[] = [];
  // stdout 以 \x1e 开头（首条记录），split 后首段为空串，filter(Boolean) 去除
  const records = stdout.split("\x1e").map(r => r.trim()).filter(Boolean);

  for (const record of records) {
    // record 结构："sha\x1fdate\x1fmessage\n\nfile1\nfile2..."（name-only 在 message 后带空行）
    const lines = record.split("\n");
    const header = lines[0] ?? "";
    const fields = header.split("\x1f");
    if (fields.length < 3) continue;
    const [sha, date] = fields;
    const message = fields.slice(2).join("\x1f");  // message 理论上不含 \x1f，防御性 join
    const filesChanged = lines.slice(1).map(f => f.trim()).filter(Boolean);
    commits.push({ sha: sha ?? "", date: date ?? "", message: message ?? "", filesChanged });
  }

  return commits;
}

/**
 * 获取 commit 的详细信息（包含修改的文件列表）
 * @param repoPath 仓库根目录路径
 * @param commitSha commit SHA
 * @returns commit 详情（包含修改的文件列表）
 */
export async function getCommitDetails(
  repoPath: string,
  commitSha: string
): Promise<{ sha: string; message: string; filesChanged: string[] }> {
  try {
    // 获取 commit message
    const { stdout: messageStdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%s", commitSha],
      { cwd: repoPath }
    );
    const message = messageStdout.trim();

    // 获取修改的文件列表
    const { stdout: filesStdout } = await execFileAsync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha],
      { cwd: repoPath }
    );
    const filesChanged = filesStdout.trim().split("\n").filter(f => f.length > 0);

    return {
      sha: commitSha,
      message,
      filesChanged,
    };
  } catch (error) {
    throw new Error(`Failed to get commit details for ${commitSha}: ${error}`, { cause: error });
  }
}
