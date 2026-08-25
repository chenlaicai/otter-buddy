/**
 * 文件轨迹提取器（F20260825hndf 件②）
 *
 * 从 session entries 机械提取文件操作轨迹，零 LLM 成本。
 * Layer 1：SDK 的 read/write/edit 工具 → 直接提取 path（精确）
 * Layer 2：bash 命令正则匹配写操作模式（启发式，覆盖 cat >, sed -i, tee, heredoc, cp, mv）
 *
 * 输出渲染为 markdown 文本，注入新 session 的用户消息。
 */

import fs from 'fs';

import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/** 文件操作记录 */
interface FileOps {
  read: Map<string, number>;    // path → 访问次数
  written: Map<string, { count: number; lastTimestamp?: number }>;  // path → 操作次数+最后时间
}

/** 文件轨迹结果 */
export interface FileTrail {
  modified: Array<{ path: string; count: number; label: string }>;
  readOnly: string[];
  workspaceFiles: string[];
}

/** bash 写操作正则模式 */
const BASH_WRITE_PATTERNS: Array<{ regex: RegExp; group: number }> = [
  // cat/echo/printf > file 或 >> file
  { regex: /(?:^|[;&|]\s*)(?:cat|echo|printf)\s*(?:>>?)\s*([^\s;<>&|`$(){}]+)/gm, group: 1 },
  // sed -i ... file
  { regex: /(?:^|[;&|]\s*)sed\s+(?:-[^\s]*\s+)*-i\S*\s+(?:[^\s]+\s+)*([^\s;<>&|`$(){}]+)/gm, group: 1 },
  // | tee [-a] file
  { regex: /\|\s*tee\s+(?:-a\s+)?([^\s;<>&|`$(){}]+)/gm, group: 1 },
  // cp src dst（取最后一个参数为目标）
  { regex: /(?:^|[;&|]\s*)cp\s+(?:-[^\s]*\s+)*(?:[^\s]+\s+)+([^\s;<>&|`$(){}]+)/gm, group: 1 },
  // mv src dst（取最后一个参数为目标）
  { regex: /(?:^|[;&|]\s*)mv\s+(?:-[^\s]*\s+)*(?:[^\s]+\s+)+([^\s;<>&|`$(){}]+)/gm, group: 1 },
];

/** bash 读操作正则模式（排除已被写操作捕获的） */
const BASH_READ_PATTERNS: RegExp[] = [
  /(?:^|[;&|]\s*)(?:cat|less|head|tail|wc|grep)\s+(?:-[^\s]*\s+)*([^\s;<>&|`$(){}>]+)/gm,
];

/**
 * 从 session entries 提取文件操作。
 */
// eslint-disable-next-line complexity -- 多层文件操作提取逻辑，拆分反而降低可读性
function extractFileOps(entries: SessionEntry[]): FileOps {
  const ops: FileOps = { read: new Map(), written: new Map() };

  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const msg = (entry as { message: unknown }).message as Record<string, unknown>;
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'toolCall' || typeof b.name !== 'string') continue;
      const args = b.arguments as Record<string, unknown> | undefined;
      if (!args) continue;

      const filePath = typeof args.path === 'string' ? args.path : undefined;

      // Layer 1: SDK 工具精确提取
      if (b.name === 'read' && filePath) {
        ops.read.set(filePath, (ops.read.get(filePath) ?? 0) + 1);
      } else if (b.name === 'write' && filePath) {
        addWritten(ops, filePath, (entry as { timestamp?: string }).timestamp);
      } else if (b.name === 'edit' && filePath) {
        addWritten(ops, filePath, (entry as { timestamp?: string }).timestamp);
      }

      // Layer 2: bash 命令启发式提取
      if (b.name === 'bash' && typeof args.command === 'string') {
        const command = args.command as string;
        extractBashFileOps(command, ops, (entry as { timestamp?: string }).timestamp);
      }
    }
  }

  return ops;
}

/** 记录写操作 */
function addWritten(ops: FileOps, filePath: string, timestamp?: string): void {
  const existing = ops.written.get(filePath);
  const ts = timestamp ? new Date(timestamp).getTime() : undefined;
  if (existing) {
    existing.count++;
    if (ts && (!existing.lastTimestamp || ts > existing.lastTimestamp)) {
      existing.lastTimestamp = ts;
    }
  } else {
    ops.written.set(filePath, { count: 1, lastTimestamp: ts });
  }
}

/** 从 bash 命令中提取文件操作 */
function extractBashFileOps(command: string, ops: FileOps, timestamp?: string): void {
  const writtenPaths = new Set<string>();

  // 先匹配写操作
  for (const { regex, group } of BASH_WRITE_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(command)) !== null) {
      const p = match[group];
      if (p && isValidFilePath(p)) {
        writtenPaths.add(p);
        addWritten(ops, p, timestamp);
      }
    }
  }

  // 再匹配读操作（排除已识别为写的）
  for (const pattern of BASH_READ_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(command)) !== null) {
      const p = match[1];
      if (p && isValidFilePath(p) && !writtenPaths.has(p) && !ops.written.has(p)) {
        ops.read.set(p, (ops.read.get(p) ?? 0) + 1);
      }
    }
  }
}

/** 基本路径合法性检查 */
function isValidFilePath(p: string): boolean {
  if (!p || p.length > 500) return false;
  // 排除明显的非路径字符串
  if (/^--?[a-z]/.test(p)) return false; // flag
  if (/^\d+$/.test(p)) return false;     // pure number
  if (p === '-' || p === '--') return false;
  // 至少包含一个 / 或 . 才像路径
  return p.includes('/') || p.includes('.');
}

/**
 * 从文件操作构建文件轨迹。
 * @param entries session entries
 * @param maxEntries 最大条目数
 */
export function extractFileTrail(
  entries: SessionEntry[],
  maxEntries: number = 30,
): FileTrail {
  const ops = extractFileOps(entries);

  // 修改的文件（按访问次数降序）
  const modified = [...ops.written.entries()]
    .map(([p, v]) => ({ path: p, count: v.count, label: formatCount(v.count, v.lastTimestamp) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxEntries);

  // 只读文件（排除已修改的，取前 10 个）
  const modifiedPaths = new Set(ops.written.keys());
  const readOnly = [...ops.read.entries()]
    .filter(([p]) => !modifiedPaths.has(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p]) => p);

  return { modified, readOnly, workspaceFiles: [] };
}

/**
 * 扫描工作区目录，填充 workspaceFiles。
 */
export function scanWorkspaceFiles(workspacePath: string, maxFiles: number = 20): string[] {
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => e.name + (e.isDirectory() ? '/' : ''))
      .slice(0, maxFiles);
  } catch {
    return [];
  }
}

/** 格式化操作计数 */
function formatCount(count: number, lastTimestamp?: number): string {
  const timeStr = lastTimestamp
    ? new Date(lastTimestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
    : '';
  const countStr = count > 1 ? `×${count}` : '';
  return timeStr ? `${countStr} 最后 ${timeStr}`.trim() : countStr;
}

/**
 * 渲染文件轨迹为 markdown 文本。
 */
export function renderFileTrail(trail: FileTrail): string {
  const parts: string[] = ['## 文件轨迹（机械提取，未经 LLM 加工）'];

  if (trail.modified.length > 0) {
    parts.push(`### 修改/创建（${trail.modified.length} 个）`);
    for (const f of trail.modified) {
      parts.push(`- ${f.path}${f.label ? `（${f.label}）` : ''}`);
    }
  } else {
    parts.push('### 修改/创建（无）');
  }

  if (trail.readOnly.length > 0) {
    parts.push(`### 只读参考（${trail.readOnly.length} 个）`);
    for (const f of trail.readOnly) {
      parts.push(`- ${f}`);
    }
  }

  if (trail.workspaceFiles.length > 0) {
    parts.push(`### 工作区存量（${trail.workspaceFiles.length} 个文件）`);
    for (const f of trail.workspaceFiles) {
      parts.push(`- ${f}`);
    }
  }

  return parts.join('\n');
}
