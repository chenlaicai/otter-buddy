/**
 * pi session 文件（jsonl）读取。SDK 会话文件格式是 SDK 版本敏感的，
 * 全部解析逻辑集中在本文件——格式变化只需要改这里。
 */
import * as fs from "node:fs";
import type Database from "better-sqlite3";
import { readDurableActiveSessionEntries } from "@frameworks/agent/durable-slice-source";

export interface SessionEntry {
  raw: Record<string, unknown>;
  /** 条目序列化文本（断言包含性用，不解析内部结构） */
  text: string;
  isUser: boolean;
}

function detectUser(entry: Record<string, unknown>): boolean {
  if (entry.role === "user") return true;
  if (entry.type === "user") return true;
  const msg = entry.message as Record<string, unknown> | undefined;
  if (msg?.role === "user") return true;
  return false;
}

/** 读取当前 pi session：durable sqlite 走公开只读投影，旧 jsonl 保留容错解析。 */
export async function readSessionMessages(sessionFile: string): Promise<SessionEntry[]> {
  if (sessionFile.endsWith(".sqlite")) {
    const projected = await readDurableActiveSessionEntries(sessionFile);
    return (projected ?? []).map(raw => ({
      raw,
      text: JSON.stringify(raw),
      isUser: detectUser(raw),
    }));
  }
  const content = fs.readFileSync(sessionFile, "utf8");
  const entries: SessionEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      entries.push({ raw, text: line, isUser: detectUser(raw) });
    } catch {
      /* 容错跳过坏行 */
    }
  }
  return entries;
}

/** 从 agent_sessions 表取 otter 的 session 文件路径 */
export function getSessionFile(db: Database.Database, otterId: string): string | null {
  const row = db.prepare("SELECT session_file FROM agent_sessions WHERE otter_id = ?").get(otterId) as { session_file: string } | undefined;
  return row?.session_file || null;
}
