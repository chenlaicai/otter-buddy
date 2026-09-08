/**
 * LRU Session Pool：常驻活跃 session 对象，避免每次 invoke 冷启动 restore。
 *
 * F20260908rlcp Part B：热池实现。
 * - 容量默认 50（config.llm.sessionPoolSize）+ 空闲 TTL 默认 30min
 * - 准入：信号到达→在池直接用；不在→restore 入池；池满 LRU 驱逐最旧空闲条目
 * - 驱逐守卫：运行中（isStreaming）不可驱逐
 * - 对外接口：isRunning / followUp / steer（Part A signal-router 依赖）
 * - 崩溃：池蒸发无数据损失（jsonl 已持久），重启全部冷启动
 */

import type { Logger } from "@usecases/ports/logger";
import type { ToolContext } from "@usecases/ports/agent-tools";

/** SDK AgentSession 的最小接口（避免直接依赖 SDK 类型） */
export interface PooledSession {
  prompt(text: string, options?: unknown): Promise<void>;
  followUp(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  state: { errorMessage?: string };
  getSessionStats(): { tokens: { input: number; output: number } };
  sessionManager: { getBranch(): unknown[] };
}

/** 池条目 */
export interface SessionPoolEntry {
  /** SDK AgentSession 对象（有 prompt/steer/followUp/abort/dispose） */
  session: PooledSession;
  /** otterId（池键，per-otter 单对象） */
  otterId: string;
  /** 当前绑定的 conversationId（池复用时刷新） */
  conversationId: string;
  /** 工具上下文（mutable 引用，池复用时刷新关键字段） */
  toolContext: ToolContext;
  /** 当前 turn 文本缓冲（mutable 引用，池复用时清零） */
  turnText: { text: string };
  /** 最后活跃时间戳（ms） */
  lastActiveAt: number;
  /** 是否正在 streaming（prompt 运行中） */
  isStreaming: boolean;
}

export interface SessionPoolConfig {
  /** 最大条目数，默认 50 */
  maxSize: number;
  /** 空闲 TTL（ms），默认 30min */
  idleTtlMs: number;
}

/** TTL 扫描间隔（1 分钟） */
const TTL_SCAN_INTERVAL_MS = 60_000;

export class SessionPool {
  /** otterId → entry */
  private readonly entries = new Map<string, SessionPoolEntry>();
  private readonly config: SessionPoolConfig;
  private readonly logger: Logger;
  private ttlTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SessionPoolConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.startTtlScanner();
  }

  /**
   * 获取池条目（命中时更新 lastActiveAt）。
   * 调用方负责刷新 toolContext 字段。
   */
  acquire(otterId: string): SessionPoolEntry | null {
    const entry = this.entries.get(otterId);
    if (!entry) return null;
    entry.lastActiveAt = Date.now();
    return entry;
  }

  /**
   * 放入池条目。池满时驱逐最旧空闲条目。
   * 若同 otterId 已有条目且 session 不同，先 dispose 旧 session。
   */
  put(entry: SessionPoolEntry): void {
    const existing = this.entries.get(entry.otterId);
    if (existing && existing.session !== entry.session) {
      // Why: 旧 session 被替换（reset/destroy 场景），dispose 释放内存
      this.logger.debug(`[pool] replacing session for ${entry.otterId}`);
      try { existing.session.dispose(); } catch { /* dispose 失败不阻塞 */ }
    }

    // 驱逐至容量允许
    while (this.entries.size >= this.config.maxSize) {
      if (!this.evictOne()) {
        this.logger.warn(`[pool] pool full (${this.config.maxSize}), all entries streaming, cannot evict`);
        // Why: 驱逐失败（所有条目运行中）时不入池——池满是硬约束，不降级覆盖
        return;
      }
    }

    entry.lastActiveAt = Date.now();
    this.entries.set(entry.otterId, entry);
    this.logger.debug(`[pool] session acquired for ${entry.otterId}, pool size=${this.entries.size}`);
  }

  /** 标记 entry streaming 状态 */
  markStreaming(otterId: string, streaming: boolean): void {
    const entry = this.entries.get(otterId);
    if (entry) {
      entry.isStreaming = streaming;
      if (!streaming) {
        // Why: streaming 结束时刷新 lastActiveAt，TTL 从此刻开始计时
        entry.lastActiveAt = Date.now();
      }
    }
  }

  /**
   * 移除并 dispose 指定 otter 的池条目。
   * 用于 destroy/reset 场景。
   */
  remove(otterId: string): void {
    const entry = this.entries.get(otterId);
    if (entry) {
      try { entry.session.dispose(); } catch { /* dispose 失败不阻塞 */ }
      this.entries.delete(otterId);
      this.logger.debug(`[pool] session removed for ${otterId}, pool size=${this.entries.size}`);
    }
  }

  /**
   * 检查 otter 是否在池且正在运行（isStreaming）。
   * Part A signal-router 依赖此接口。
   */
  isRunning(otterId: string): boolean {
    const entry = this.entries.get(otterId);
    return !!entry && entry.isStreaming;
  }

  /**
   * 向运行中的 session 队列追加 followUp 消息。
   * 在池且运行中→session.followUp→true；否则 false。
   * Part A signal-router 依赖此接口。
   */
  followUp(otterId: string, text: string): boolean {
    const entry = this.entries.get(otterId);
    if (!entry || !entry.isStreaming) return false;
    void entry.session.followUp(text).catch((err: unknown) => {
      this.logger.warn(`[pool] followUp failed otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  /**
   * 向运行中的 session 队列追加 steer（急讯）消息。
   * 在池且运行中→session.steer→true；否则 false。
   * Part A signal-router 依赖此接口。
   */
  steer(otterId: string, text: string): boolean {
    const entry = this.entries.get(otterId);
    if (!entry || !entry.isStreaming) return false;
    void entry.session.steer(text).catch((err: unknown) => {
      this.logger.warn(`[pool] steer failed otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  /** 当前池大小 */
  get size(): number { return this.entries.size; }

  /**
   * 清理：dispose 所有 session，停止 TTL 扫描。
   * 进程关闭时调用。
   */
  dispose(): void {
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = null;
    }
    for (const entry of this.entries.values()) {
      try { entry.session.dispose(); } catch { /* dispose 失败不阻塞 */ }
    }
    this.entries.clear();
    this.logger.info('[pool] disposed all sessions');
  }

  /**
   * LRU 驱逐：找到最旧的空闲条目并移除。
   * 返回 true 表示成功驱逐，false 表示所有条目都在运行中。
   */
  private evictOne(): boolean {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (!entry.isStreaming && entry.lastActiveAt < oldestTime) {
        oldestKey = key;
        oldestTime = entry.lastActiveAt;
      }
    }
    if (oldestKey !== null) {
      this.logger.info(`[pool] LRU evicting idle session: ${oldestKey}`);
      this.remove(oldestKey);
      return true;
    }
    return false;
  }

  /**
   * TTL 扫描器：每分钟检查一次，驱逐超过 idleTtlMs 的空闲条目。
   * Why: 防止长时间无信号的 session 常驻内存。
   */
  private startTtlScanner(): void {
    this.ttlTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (!entry.isStreaming && (now - entry.lastActiveAt) > this.config.idleTtlMs) {
          this.logger.info(`[pool] TTL expired, evicting idle session: ${key}, idle for ${Math.round((now - entry.lastActiveAt) / 1000)}s`);
          this.remove(key);
        }
      }
    }, TTL_SCAN_INTERVAL_MS);
    // Why: unref 防止 TTL 定时器阻止进程退出
    if (this.ttlTimer && typeof this.ttlTimer === 'object' && 'unref' in this.ttlTimer) {
      (this.ttlTimer as NodeJS.Timeout).unref();
    }
  }
}
