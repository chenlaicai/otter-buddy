/**
 * SessionSanitizer：session 文件退化内容清洗器（F20260804dglp 修复 3/4）。
 *
 * 斩断污染飞轮：退化文本经 abort 部分落盘 / 正常 toolUse 落盘两条路径进入
 * session 历史后，会被后续 invoke 全量携带，诱发模型模仿重复。本清洗器在
 * invoke 结束后（session.dispose() 之后）对 jsonl 做幂等清洗：
 *
 * - 扫描范围：当前活跃分支路径（叶节点沿 parentId 回溯，同 buildSessionPath
 *   语义）；非活跃分支不进 LLM 上下文（buildContextEntries 只走叶路径），不洗；
 * - 命中退化块（text/thinking）：原位替换为占位符，entry id/parentId 不动，
 *   append-only 树结构与 compaction 的 firstKeptEntryId 引用不受破坏；
 * - thinkingSignature 规则：命中的 thinking 块连同 signature 一起清除——
 *   只换内容留 signature 会导致 Anthropic 端点签名校验 400（该 otter 每次 invoke 必挂）；
 * - 写盘：临时文件 + 原子 rename + .bak 备份（同名覆盖，只留最近一份）；
 * - 竞态前提：调用方必须保证目标 session 无活跃写入（SDK 稳态写入是 appendFileSync
 *   追加，清洗是全量读-改-写，交错会丢新 entry 导致 parentId 悬空）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeText } from "./degenerate-detector";
import type { DegenerateConfig, DegenerateVerdict } from "./degenerate-detector";

export interface SanitizeResult {
  /** 扫描的活跃分支 assistant entry 数 */
  scannedEntries: number;
  /** 替换的退化块数 */
  replacedBlocks: number;
  /** 命中明细（entry id + 块类型 + 原始长度 + 判定机制） */
  hits: Array<{ entryId: string; blockType: string; originalLength: number; mechanism: string }>;
  /** 是否发生了文件改写 */
  fileRewritten: boolean;
}

interface SessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>>;
  };
}

interface ParsedLine {
  entry: SessionEntry;
  lineIndex: number;
}

const NO_OP_RESULT: SanitizeResult = { scannedEntries: 0, replacedBlocks: 0, hits: [], fileRewritten: false };

/** 占位符：保留原始长度信息便于审计 */
function placeholder(blockType: string, originalLength: number): string {
  return `[输出异常重复，已截断。块类型 ${blockType}，原始长度 ${originalLength} 字符]`;
}

/** 从叶节点沿 parentId 回溯活跃分支（同 SDK buildSessionPath 语义：叶 = 最后一条 entry） */
function resolveActiveBranch(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) {
    if (e.id) byId.set(e.id, e);
  }
  const leaf = [...entries].reverse().find((e) => e.id);
  if (!leaf) return [];
  const pathEntries: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    pathEntries.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return pathEntries;
}

/** 解析 jsonl 行；不可解析行跳过（回写时原样保留） */
function parseLines(lines: string[]): { parsed: ParsedLine[]; entries: SessionEntry[] } {
  const parsed: ParsedLine[] = [];
  const entries: SessionEntry[] = [];
  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line) as SessionEntry;
      parsed.push({ entry, lineIndex });
      entries.push(entry);
    } catch {
      /** 保留原行（header 或非 JSON 行不动） */
    }
  });
  return { parsed, entries };
}

/** 清洗单个内容块；命中返回判定并原位替换 */
function sanitizeBlock(
  block: Record<string, unknown>,
  detectorConfig?: Partial<DegenerateConfig>,
): { verdict: DegenerateVerdict; blockType: string; originalLength: number } | null {
  const blockType = block.type as string | undefined;
  const field = blockType === "text" ? "text" : blockType === "thinking" ? "thinking" : null;
  if (!field) return null;
  const content = block[field];
  if (typeof content !== "string" || content.length === 0) return null;
  const verdict = analyzeText(content, detectorConfig);
  if (!verdict.degenerate) return null;

  const originalLength = content.length;
  block[field] = placeholder(blockType ?? "unknown", originalLength);
  /** thinkingSignature 连带清除：内容已替换，保留 signature 会触发端点签名校验 400 */
  if (blockType === "thinking" && "thinkingSignature" in block) {
    delete block.thinkingSignature;
  }
  return { verdict, blockType: blockType ?? "?", originalLength };
}

/** 备份（同名覆盖，只留最近一份）+ 临时文件原子 rename */
function writeAtomically(filePath: string, lines: string[], replacedLines: Map<number, string>): void {
  const out = lines.map((line, i) => replacedLines.get(i) ?? line).join("\n");
  fs.copyFileSync(filePath, filePath + ".bak");
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.sanitize-${process.pid}.tmp`);
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, filePath);
}

/** 扫描活跃分支上的 assistant entry，命中块原位替换；返回命中明细与被改 entry 集合 */
function scanBranchEntries(
  parsed: ParsedLine[],
  branchSet: Set<SessionEntry>,
  detectorConfig?: Partial<DegenerateConfig>,
): { hits: SanitizeResult["hits"]; dirtyEntries: Set<SessionEntry>; scannedEntries: number } {
  const hits: SanitizeResult["hits"] = [];
  const dirtyEntries = new Set<SessionEntry>();
  let scannedEntries = 0;

  for (const { entry } of parsed) {
    if (!branchSet.has(entry)) continue;
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    scannedEntries++;
    for (const block of entry.message.content ?? []) {
      const hit = sanitizeBlock(block, detectorConfig);
      if (!hit || !hit.verdict.degenerate) continue;
      hits.push({
        entryId: entry.id ?? "?",
        blockType: hit.blockType,
        originalLength: hit.originalLength,
        mechanism: hit.verdict.mechanism,
      });
      dirtyEntries.add(entry);
    }
  }
  return { hits, dirtyEntries, scannedEntries };
}

/**
 * 清洗 session 文件。幂等：无命中时不写盘。
 * detectorConfig 可覆盖离线参数（离线无运行时误杀代价，可放宽）。
 */
export function sanitizeSessionFile(filePath: string, detectorConfig?: Partial<DegenerateConfig>): SanitizeResult {
  if (!fs.existsSync(filePath)) return NO_OP_RESULT;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const { parsed, entries } = parseLines(lines);

  const branchSet = new Set(resolveActiveBranch(entries));
  if (branchSet.size === 0) return NO_OP_RESULT;

  const { hits, dirtyEntries, scannedEntries } = scanBranchEntries(parsed, branchSet, detectorConfig);
  if (dirtyEntries.size === 0) return { scannedEntries, replacedBlocks: 0, hits: [], fileRewritten: false };

  /** 回写：只重序列化命中的 entry 行，其余行原样保留 */
  const replacedLines = new Map<number, string>();
  for (const { entry, lineIndex } of parsed) {
    if (dirtyEntries.has(entry)) replacedLines.set(lineIndex, JSON.stringify(entry));
  }
  writeAtomically(filePath, lines, replacedLines);

  return { scannedEntries, replacedBlocks: hits.length, hits, fileRewritten: true };
}

