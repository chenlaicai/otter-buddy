import fs from "node:fs";
import path from "node:path";
import type { WeixinConfig } from "./types";

/**
 * 微信账号状态持久化（frameworks 层文件实现）。
 *
 * 存储布局（对照 openclaw 的 ~/.openclaw 但落我们自己的 data 目录）：
 *   <stateDir>/accounts.json          — 账号索引：{ id → { token, ilinkBotId, ilinkUserId, baseUrl, addedAt } }
 *   <stateDir>/<accountId>/sync-buf.json — getupdates 游标（进程重启后从断点续拉）
 *   <stateDir>/<accountId>/context-tokens.json — 对端用户 → context_token 映射（出站回消息必需）
 *
 * 微信协议限制：context_token 由入站消息携带、有时效——重启后不可再造，只能等
 * 用户发来新消息。因此 context-tokens 与账号 token 同等重要，独立持久化。
 */
export interface WeixinAccount {
  id: string;
  /** bot_token（扫码授权换取的长效凭证） */
  token: string;
  ilinkBotId?: string;
  /** 扫码授权人的 user id（一般即搭档） */
  ilinkUserId?: string;
  baseUrl?: string;
  addedAt: string;
}

/** context_token 条目 v2 格式（F20260901wxnt：token 年龄追踪 + 预警状态） */
export interface ContextTokenEntry {
  token: string;
  /** 该 token 落盘时刻（= 最近一条入站消息到达时刻） */
  receivedAt: number;
  /** 最近一次预警发送尝试时刻（无论成败都记——防死 token 每 35s 被重锤） */
  warnedAt?: number;
}

export class WeixinAccountStore {
  private readonly stateDir: string;

  constructor(config: Pick<WeixinConfig, "stateDir"> | undefined) {
    this.stateDir = config?.stateDir ?? "./data/weixin";
  }

  private accountsPath(): string {
    return path.join(this.stateDir, "accounts.json");
  }

  listAccounts(): WeixinAccount[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.accountsPath(), "utf-8")) as Record<string, WeixinAccount>;
      return Object.values(raw);
    } catch {
      return [];
    }
  }

  getAccount(id: string): WeixinAccount | undefined {
    return this.listAccounts().find((a) => a.id === id);
  }

  /** upsert 账号（扫码成功后调用）。?? {}：首次落盘时 accounts.json 尚不存在，
   * safeRead 返回 null——直接属性赋值会 TypeError（PR① 遗留 bug，web 登录测试暴露） */
  saveAccount(account: WeixinAccount): void {
    const raw = (this.safeRead(this.accountsPath()) as Record<string, WeixinAccount> | null) ?? {};
    raw[account.id] = account;
    this.safeWrite(this.accountsPath(), raw);
  }

  removeAccount(id: string): void {
    const raw = (this.safeRead(this.accountsPath()) as Record<string, WeixinAccount> | null) ?? {};
    delete raw[id];
    this.safeWrite(this.accountsPath(), raw);
    // 账号删除时连带清理游标与 context token
    fs.rmSync(path.join(this.stateDir, id), { recursive: true, force: true });
  }

  // ── getupdates 游标 ──

  loadSyncBuf(accountId: string): string {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(this.stateDir, accountId, "sync-buf.json"), "utf-8"),
      ) as { buf?: string };
      return data.buf ?? "";
    } catch {
      return "";
    }
  }

  saveSyncBuf(accountId: string, buf: string): void {
    this.safeWrite(path.join(this.stateDir, accountId, "sync-buf.json"), { buf, savedAt: new Date().toISOString() });
  }

  // ── context_token 映射（对端 → token）──

  /** raw 层：返回 v2 完整结构（消费方：预警检查 + save/record 的 load-modify-save 基座） */
  loadRawContextTokens(accountId: string): Record<string, ContextTokenEntry> {
    const raw = (this.safeRead(path.join(this.stateDir, accountId, "context-tokens.json")) ?? {}) as Record<string, unknown>;
    const result: Record<string, ContextTokenEntry> = {};
    const filePath = path.join(this.stateDir, accountId, "context-tokens.json");
    for (const [userId, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        // Why: v1 兼容——值为字符串时用文件 mtime 回填 receivedAt（mtime 是「最近一次 token 落盘」的可靠代理）
        let mtime = Date.now();
        try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* 文件不存在用 now */ }
        result[userId] = { token: value, receivedAt: mtime };
      } else if (value && typeof value === "object" && "token" in value) {
        const entry = value as ContextTokenEntry;
        if (typeof entry.receivedAt === "number" && Number.isFinite(entry.receivedAt)) {
          result[userId] = entry;
        } else {
          // F20260901wxnt 发现2：v2 条目 receivedAt 非法（手改/损坏）→ 回退 mtime 兜底，与 v1 同款
          let mtime = Date.now();
          try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* 文件异常用 now */ }
          result[userId] = { ...entry, receivedAt: mtime };
        }
      }
    }
    return result;
  }

  /** 投影层：对外签名不变（消费方：gateway adapter resolveContextToken，零改动） */
  loadContextTokens(accountId: string): Record<string, string> {
    const raw = this.loadRawContextTokens(accountId);
    const projected: Record<string, string> = {};
    for (const [userId, entry] of Object.entries(raw)) {
      projected[userId] = entry.token;
    }
    return projected;
  }

  /** 写入 token v2 条目（receivedAt=now + 清除 warnedAt——入站换新 = 用户说话 = 预警使命完成） */
  saveContextToken(accountId: string, userId: string, token: string): void {
    const tokens = this.loadRawContextTokens(accountId);
    tokens[userId] = { token, receivedAt: Date.now() };
    // Why: 走 raw load-modify-save 而非投影 map——保留其他用户的 v2 元数据
    this.safeWrite(path.join(this.stateDir, accountId, "context-tokens.json"), tokens);
  }

  /** 记录预警发送时刻（无论成败都记——防死 token 被重锤） */
  recordContextTokenWarned(accountId: string, userId: string): void {
    const tokens = this.loadRawContextTokens(accountId);
    if (!tokens[userId]) return; // 无条目则忽略（理论上不会发生）
    tokens[userId].warnedAt = Date.now();
    this.safeWrite(path.join(this.stateDir, accountId, "context-tokens.json"), tokens);
  }

  private safeRead(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }

  private safeWrite(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
}
