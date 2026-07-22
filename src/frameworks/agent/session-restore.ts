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
      return this.handleMissingSession(otterId, piCodingAgent, sessionDir);
    }
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
      const sessionManager = SessionManagerClass.open(sessionFile);
      const restoredSessionId = sessionManager.getSessionId();
      if (!restoredSessionId) {
        this.logger.warn(`SessionManager.open() returned invalid state for: ${sessionFile}, creating new session`);
        return this.recreateFromConfig(otterId, piCodingAgent, sessionDir);
      }
      return { sessionManager, needsRetry: false };
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
    }, piCodingAgent, sessionDir, cause);
  }

  /** 创建 session 并返回 sessionManager */
  private createAndReturnSession(
    otterId: string,
    config: { systemPrompt?: string | OtterPromptConfig; otterType: string },
    piCodingAgent: unknown,
    sessionDir: string,
    cause?: unknown,
  ): SessionRestoreResult {
    // 删除旧记录（如果存在）
    this.sessionStore.delete(otterId);

    // 创建 session
    this.createSessionAndPersist(otterId, config, piCodingAgent, sessionDir, true);

    // 获取新创建的 sessionFile
    const stored = this.sessionStore.getWithFile(otterId);
    if (!stored?.sessionFile) {
      if (cause) {
        throw new Error(`Failed to create session for otter: ${otterId}`, { cause });
      }
      throw new Error(`Failed to create session for otter: ${otterId}`);
    }

    // 打开新创建的 session
    const SessionManagerClass = getSessionManagerClass(piCodingAgent);
    const sessionManager = SessionManagerClass.open(stored.sessionFile);
    return { sessionManager, needsRetry: false };
  }

  /** 创建 session 并持久化 */
  createSessionAndPersist(
    otterId: string,
    config: { systemPrompt?: string | OtterPromptConfig; otterType: string },
    piCodingAgent: unknown,
    sessionDir: string,
    allowOverwrite: boolean,
  ): void {
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

    // 5. 验证文件存在
    if (!fs.existsSync(sessionFile)) {
      throw new Error(`Session file does not exist: ${sessionFile}`);
    }

    // 6. 使用事务保存配置和 session 映射
    try {
      this.db.transaction(() => {
        this.otterConfigProvider.setConfig(otterId, {
          systemPrompt: config.systemPrompt,
          otterType: config.otterType as OtterType,
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
  }
}
