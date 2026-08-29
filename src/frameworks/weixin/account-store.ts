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

  /** upsert 账号（扫码成功后调用） */
  saveAccount(account: WeixinAccount): void {
    const raw = this.safeRead(this.accountsPath()) as Record<string, WeixinAccount>;
    raw[account.id] = account;
    this.safeWrite(this.accountsPath(), raw);
  }

  removeAccount(id: string): void {
    const raw = this.safeRead(this.accountsPath()) as Record<string, WeixinAccount>;
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

  loadContextTokens(accountId: string): Record<string, string> {
    return (this.safeRead(path.join(this.stateDir, accountId, "context-tokens.json")) ?? {}) as Record<string, string>;
  }

  saveContextToken(accountId: string, userId: string, token: string): void {
    const tokens = this.loadContextTokens(accountId);
    tokens[userId] = token;
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
