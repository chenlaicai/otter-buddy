/**
 * Session 恢复器：负责恢复或创建 session
 */

import fs from 'fs';
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider, OtterType } from "@usecases/ports/otter-config-provider";
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
  ) {}

  /** 恢复或创建 session */
  async restoreOrCreate(
    otterId: string,
    piCodingAgent: unknown,
    sessionDir: string,
  ): Promise<SessionRestoreResult> {
    // 从持久化存储读取 sessionFile
    const stored = this.sessionStore.getWithFile(otterId);
    if (!stored || !stored.sessionFile) {
      // 降级策略：检查 OtterConfig 是否存在
      const existingConfig = this.otterConfigProvider.getConfig(otterId);
      if (existingConfig) {
        this.logger.info(`Session file missing for otter: ${otterId}, creating new session`);
        this.createSessionAndPersist(otterId, {
          systemPrompt: existingConfig.systemPrompt,
          otterType: existingConfig.otterType,
        }, piCodingAgent, sessionDir, true);
        return { sessionManager: null, needsRetry: true };
      }
      throw new Error(`No session or config found for otter: ${otterId}. Call create() first.`);
    }

    // 创建 SessionManager（恢复已有 session）
    try {
      const SessionManagerClass = getSessionManagerClass(piCodingAgent);
      const sessionManager = SessionManagerClass.open(stored.sessionFile);

      // 验证 SessionManager 有效性
      const restoredSessionId = sessionManager.getSessionId();
      if (!restoredSessionId) {
        this.logger.warn(`SessionManager.open() returned invalid state for: ${stored.sessionFile}, creating new session`);
        this.recreateSession(otterId, piCodingAgent, sessionDir);
        return { sessionManager: null, needsRetry: true };
      }

      return { sessionManager, needsRetry: false };
    } catch (err) {
      // 区分错误类型
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.warn(`Session file not found: ${stored.sessionFile}, creating new session`);
      } else {
        this.logger.warn(`Failed to open session file: ${stored.sessionFile}`, { error: err });
      }
      // 降级到 create()
      this.recreateSession(otterId, piCodingAgent, sessionDir, err);
      return { sessionManager: null, needsRetry: true };
    }
  }

  /** 创建 session 并持久化 */
  createSessionAndPersist(
    otterId: string,
    config: { systemPrompt?: unknown; otterType: string },
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
      this.otterConfigProvider.setConfig(otterId, {
        systemPrompt: config.systemPrompt,
        otterType: config.otterType as OtterType,
      });
      this.sessionStore.setWithFile(otterId, sessionId, sessionFile);
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

  /** 重新创建 session（降级策略） */
  private recreateSession(
    otterId: string,
    piCodingAgent: unknown,
    sessionDir: string,
    cause?: unknown,
  ): void {
    this.sessionStore.delete(otterId);
    const existingConfig = this.otterConfigProvider.getConfig(otterId);
    if (existingConfig) {
      this.createSessionAndPersist(otterId, {
        systemPrompt: existingConfig.systemPrompt,
        otterType: existingConfig.otterType,
      }, piCodingAgent, sessionDir, true);
    } else if (cause) {
      throw new Error(`Session file corrupted and no config found for otter: ${otterId}`, { cause });
    } else {
      throw new Error(`Session file invalid and no config found for otter: ${otterId}`);
    }
  }
}
