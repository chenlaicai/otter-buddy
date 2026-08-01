/**
 * Session 恢复器：负责恢复或创建 session
 */

import fs from 'fs';
import type Database from "better-sqlite3";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider, OtterType } from "@usecases/ports/otter-config-provider";
import type { OtterPromptConfig } from "@contract/api/otter";
import type { AgentSessionStore } from "./agent-session-store";
import { getSessionManagerClass } from "./session-helpers";

/** Session 恢复结果 */
export interface SessionRestoreResult {
  sessionManager: SessionManager | null;
  needsRetry: boolean;
  /** 本次是否创建了全新 session（新上下文中没有身份内容，调用方应触发身份注入） */
  createdNew: boolean;
}

/** Session 恢复器 */
export class SessionRestore {
  constructor(
    private readonly sessionStore: AgentSessionStore,
    private readonly otterConfigProvider: OtterConfigProvider,
    private readonly logger: Logger,
    private readonly db: Database.Database,
  ) {}

  /** 恢复或创建 session */
  async restoreOrCreate(
    otterId: string,
    piCodingAgent: unknown,
    sessionDir: string,
  ): Promise<SessionRestoreResult> {
    const stored = this.sessionStore.getWithFile(otterId);
    if (!stored?.sessionFile) {
      this.logger.debug('[SessionRestore] No session file in DB, handling missing', { otterId });
      return this.handleMissingSession(otterId, piCodingAgent, sessionDir);
    }
    this.logger.debug('[SessionRestore] Restoring existing session', { otterId, sessionFile: stored.sessionFile });
    return this.restoreExistingSession(otterId, stored.sessionFile, piCodingAgent, sessionDir);
  }

  /** 处理 session 缺失的情况 */
  private handleMissingSession(
    otterId: string,
    piCodingAgent: unknown,
    sessionDir: string,
  ): SessionRestoreResult {
    const existingConfig = this.otterConfigProvider.getConfig(otterId);
    if (!existingConfig) {
      throw new Error(`No session or config found for otter: ${otterId}. Call create() first.`);
    }
    this.logger.info(`Session file missing for otter: ${otterId}, creating new session`);
    return this.createAndReturnSession(otterId, {
      systemPrompt: existingConfig.systemPrompt,
      otterType: existingConfig.otterType,
      modelAlias: existingConfig.modelAlias,
    }, piCodingAgent, sessionDir);
  }

  /** 恢复已有的 session */
  private restoreExistingSession(
    otterId: string,
    sessionFile: string,
    piCodingAgent: unknown,
    sessionDir: string,
  ): SessionRestoreResult {
    try {
      const SessionManagerClass = getSessionManagerClass(piCodingAgent);
      this.logger.debug('[SessionRestore] Opening session file', { otterId, sessionFile });
      const sessionManager = SessionManagerClass.open(sessionFile);
      const restoredSessionId = sessionManager.getSessionId();
      if (!restoredSessionId) {
        this.logger.warn(`SessionManager.open() returned invalid state for: ${sessionFile}, creating new session`);
        return this.recreateFromConfig(otterId, piCodingAgent, sessionDir);
      }
      return { sessionManager, needsRetry: false, createdNew: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.warn(`Session file not found: ${sessionFile}, creating new session`);
      } else {
        this.logger.warn(`Failed to open session file: ${sessionFile}`, { error: err });
      }
      return this.recreateFromConfig(otterId, piCodingAgent, sessionDir, err);
    }
  }

  /** 从配置重新创建 session */
  private recreateFromConfig(
    otterId: string,
    piCodingAgent: unknown,
    sessionDir: string,
    cause?: unknown,
  ): SessionRestoreResult {
    const config = this.otterConfigProvider.getConfig(otterId);
    return this.createAndReturnSession(otterId, {
      systemPrompt: config?.systemPrompt,
      otterType: config?.otterType ?? 'big',
      modelAlias: config?.modelAlias,
    }, piCodingAgent, sessionDir, cause);
  }

  /** 创建 session 并返回 sessionManager */
  private createAndReturnSession(
    otterId: string,
    config: { systemPrompt?: string | OtterPromptConfig; otterType: string; modelAlias?: string },
    piCodingAgent: unknown,
    sessionDir: string,
    cause?: unknown,
  ): SessionRestoreResult {
    // 删除旧记录（如果存在）
    this.sessionStore.delete(otterId);

    // 创建 session 并获取 sessionManager（延迟写入，文件可能尚未落盘）
    this.logger.debug('[SessionRestore] Creating new session', { otterId });
    const sessionManager = this.createSessionAndPersist(otterId, config, piCodingAgent, sessionDir, true);
    this.logger.debug('[SessionRestore] Session created and persisted', { otterId });

    // 验证持久化成功
    const stored = this.sessionStore.getWithFile(otterId);
    if (!stored?.sessionFile) {
      if (cause) {
        throw new Error(`Failed to create session for otter: ${otterId}`, { cause });
      }
      throw new Error(`Failed to create session for otter: ${otterId}`);
    }

    return { sessionManager, needsRetry: false, createdNew: true };
  }

  /** 创建 session 并持久化，返回 sessionManager（延迟写入，文件可能尚未落盘） */
  createSessionAndPersist(
    otterId: string,
    config: { systemPrompt?: string | OtterPromptConfig; otterType: string; modelAlias?: string },
    piCodingAgent: unknown,
    sessionDir: string,
    allowOverwrite: boolean,
  ): SessionManager {
    // 1. 检查是否已存在
    if (!allowOverwrite) {
      const existing = this.sessionStore.get(otterId);
      if (existing) {
        throw new Error(`Agent already exists for otter: ${otterId}`);
      }
    }

    // 2. 创建 SessionManager（新 session）
    const SessionManagerClass = getSessionManagerClass(piCodingAgent);
    const sessionManager = SessionManagerClass.create(process.cwd(), sessionDir);

    // 3. 获取 sessionId 和 sessionFile
    const sessionId = sessionManager.getSessionId();
    const sessionFile = sessionManager.getSessionFile();

    // 4. 验证
    if (!sessionId || !sessionFile) {
      throw new Error('Failed to create session: missing sessionId or sessionFile');
    }

    // 5. 使用事务保存配置和 session 映射
    // 注意：SessionManager.create() 使用延迟写入，文件在第一条 assistant 消息后才落盘
    try {
      this.db.transaction(() => {
        this.otterConfigProvider.setConfig(otterId, {
          systemPrompt: config.systemPrompt,
          otterType: config.otterType as OtterType,
          modelAlias: config.modelAlias,
        });
        this.sessionStore.setWithFile(otterId, sessionId, sessionFile);
      })();
    } catch (err) {
      // 事务失败时清理已创建的 session 文件
      try {
        fs.unlinkSync(sessionFile);
      } catch {
        // 清理失败不阻塞错误抛出
      }
      throw err;
    }

    return sessionManager;
  }
}
