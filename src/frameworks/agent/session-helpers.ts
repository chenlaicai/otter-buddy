/**
 * Session 复用相关的辅助函数和类
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OtterPromptConfig } from "@contract/api/otter";
import type { DynamicContext } from "@usecases/ports/sdk-invoke-port";
import type { Logger } from "@usecases/ports/logger";
import { SessionLockConflictError } from "@entities/errors";
import { loadToolManifest, getToolNamesFromManifest } from "../config/tool-manifest-loader";

/**
 * 按 otterType 获取编码工具列表。
 * big otter 和 small otter 均启用全部编码工具（read/write/edit/bash + grep/find/ls）。
 * Why: small otter 需要写代码（开发獭）、评论 PR（检视獭）、执行构建命令等实际工作，
 * 只给 read 会导致它们无法完成任务。管理类工具的隔离在 getOtterToolNamesForType 中控制。
 * F20260904（#776）：加入 pi 内置的 grep/find/ls 专用工具——此前搜索/浏览全走 bash 管道，
 * 输出无结构且量不可控（《对话中invoke机制》大獭 session 实测 bash 占 1.6M 字符中的 950K，
 * 是 538K token 上下文膨胀的最大单一来源）。pi 的专用工具自带结果截断与格式化，
 * 语义清晰可降低试探性调用。pi 侧 createAllToolDefinitions 全量创建工具 registry，
 * activeToolNames 按名激活（sdk.js L139-144），白名单加名即生效，SDK 零改动。
 */
export function getCodingToolsForOtterType(_otterType: string | undefined): string[] {
  // big 和 small otter 均启用全部编码工具（含搜索/浏览专用工具）
  return ["read", "write", "edit", "bash", "grep", "find", "ls"];
}

/**
 * 按 otterType 获取 Otter 自定义工具名称白名单。
 *
 * F20260820a4rt: 从硬编码改为声明式 manifest 路由。
 * - 优先从 config/tool-manifest.json 加载配置
 * - manifest 加载失败时 fallback 到硬编码默认值（兼容性保证）
 *
 * @param otterType - otter 类型名
 * @param allToolNames - 当前 session 可用的全部工具名（由调用方从 createTools 传入）
 * @param projectRoot - 项目根目录（用于定位 manifest 文件）
 * @param logger - 可选日志器
 */
export function getOtterToolNamesForType(
  otterType: string | undefined,
  allToolNames?: string[],
  projectRoot?: string,
  logger?: { warn: (msg: string) => void; error: (msg: string) => void },
): string[] {
  // Fallback 默认工具列表（与原硬编码一致）
  const fallbackToolNames = allToolNames ?? [
    "speak", "yield", "search_memory",
    "create_otter", "dissolve_otter", "restart_otter", "create_linked_resource", "get_memory_detail",
    "get_message", "list_messages", "search_messages", "get_turn_history",
    "get_context", "set_context", "delete_context",
    "search_terminology", "add_terminology",
    "list_artifacts", "update_artifact_status",
    "get_active_participants", "get_html_card_contract",
    "manage_healing_events",
    "create_scheduled_task",
    "workspace_info", "workspace_list", "workspace_read", "workspace_write",
    "link_memory", "get_related", "unlink_memory",
    "sync_docs",
    "query_dispatch_ledger", // F20260821i336：派工台账查询工具
    "query_signals", // F20260826mwrd C1：信号台账查询（halt 是编排动作，仅 big 型）
    "halt_otter", "resolve_signal", // F20260826mwrd C2：编排/裁决仅 big 型
  ];

  // 尝试从 manifest 加载
  if (projectRoot) {
    const manifest = loadToolManifest(projectRoot, logger);
    if (manifest) {
      return getToolNamesFromManifest(manifest, otterType ?? "big", fallbackToolNames);
    }
  }

  // Fallback: 硬编码默认行为（manifest 加载失败时）
  if (!otterType || otterType === "big") {
    return fallbackToolNames;
  }

  /** small otter：消息检索 + 记忆 + 上下文 + 术语库 + 产物管理 + 参与者查询 + 工作区 + 定时任务 + 自愈管理 + 自身重启，不含 Otter 管理类工具（create_otter/dissolve_otter）。
   *  restart_otter 工具内部有访问控制：小獭只能重启自己。
   *  F20260826mwrd C1：query_signals 开放（复盘自己的 halt/信号）；halt_otter 仅 big。
   *  F20260826mwrd C2：resolve_signal 仅 big（裁决权在大獭）。 */
  return [
    "speak", "yield", "search_memory", "create_linked_resource", "get_memory_detail",
    "get_message", "list_messages", "search_messages", "get_turn_history",
    "get_context", "set_context", "delete_context",
    "search_terminology", "add_terminology",
    "list_artifacts", "update_artifact_status",
    "get_active_participants", "get_html_card_contract",
    "create_scheduled_task", "manage_healing_events",
    "restart_otter",
    "workspace_info", "workspace_list", "workspace_read", "workspace_write",
    "link_memory", "get_related", "unlink_memory",
    "sync_docs",
    "query_signals", // F20260826mwrd C1：小獭可查信号台账（halt_otter 仅 big 型）
  ];
}

/**
 * 简单的锁管理器，使用队列实现，避免竞态条件。
 *
 * Why: 显式跟踪 held 状态 —— 旧版仅检查 waiters 队列长度，
 * 第一个获取锁的人不入队，导致第二个调用者也看到队列为空而直接获锁，
 * 两个操作并发执行（EEXIST 竞态条件的根因，见 #376）。
 *
 * #599：stale 持有强制接管（steal）——invoke 在整个 agent 运行期间持锁
 * （正常可达数分钟），但持有超过 stealThreshold（默认 5 分钟）只可能来自异常路径
 * （abort 后 session.run 未 settle 的僵尸持有等）。继续等待必然 30s 超时抛错，
 * 把恢复失败留给用户手动收拾（#599 现场：10 分钟内 3 次手动中断僵尸发言）。
 * steal 后旧持有者的 release 对已易主的锁是 no-op（generation 世代号判定）。
 */
export class SimpleLockManager {
  private locks = new Map<string, { held: boolean; heldAt: number | null; generation: number; waiters: Array<() => void> }>();
  private readonly defaultTimeout: number;
  /** #599：锁持有超龄阈值——超过该时长视为 stale，等待中的 acquire 可强制接管 */
  private readonly stealThresholdMs: number;

  constructor(
    timeoutMs: number = 30000,
    /** 可选日志器：锁获取超时时输出结构化诊断日志（#423 方案 1） */
    private readonly logger?: Logger,
    stealThresholdMs: number = 300_000,
  ) {
    this.defaultTimeout = timeoutMs;
    this.stealThresholdMs = stealThresholdMs;
  }

  async acquire(key: string, timeoutMs?: number): Promise<() => void> {
    const timeout = timeoutMs ?? this.defaultTimeout;
    const waitStartedAt = Date.now();
    let lock = this.locks.get(key);
    if (!lock) {
      lock = { held: false, heldAt: null, generation: 0, waiters: [] };
      this.locks.set(key, lock);
    }

    // Why: 检查 held（非 waiters.length）—— 第一个获取者不会入队，
    // 旧版检查队列长度导致两个调用者都绕过等待。
    if (lock.held) {
      const holderAgeMs = lock.heldAt !== null ? Date.now() - lock.heldAt : null;
      if (holderAgeMs !== null && holderAgeMs >= this.stealThresholdMs) {
        // Why(#599): stale 持有强制接管——holderAge 超阈值说明持有者已异常
        // （正常 invoke 数分钟内结束；abort 后 session.run 未 settle 会永久持有）。
        // generation+1 使旧持有者的 release 对易主后的锁 no-op；waiters 保留，
        // 旧等待者继续排队等新持有者释放（FIFO 语义不破坏）。
        this.logger?.warn(
          `Lock stolen from stale holder: ${key}`,
          {
            module: 'SimpleLockManager',
            lockKey: key,
            otterId: key.startsWith('session:') ? key.slice('session:'.length) : undefined,
            holderHeldForMs: holderAgeMs,
            stealThresholdMs: this.stealThresholdMs,
          },
        );
        lock.generation += 1;
        // fall through：不走等待队列，直接接管（下方 held/heldAt 赋值）
      } else {
        await this.waitForLock(key, lock, timeout, waitStartedAt);
      }
    }

    lock.held = true;
    lock.heldAt = Date.now();
    /** Why(#599): 捕获本次持有世代——release 时世代不匹配（已被 steal）则 no-op */
    const myGeneration = lock.generation;

    // Why: released 标志防止 double release（调用方意外多次调用 release 函数）
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Why(#599): 世代不匹配 = 锁已被 stale 接管者夺走。此时动锁状态会
      // 干扰新持有者（错误释放或错误移交），本次 release 必须是 no-op。
      if (lock.generation !== myGeneration) return;

      const next = lock.waiters.shift();
      if (next) {
        // Why: 保持 held=true —— 锁转移给下一个等待者，不经过 unheld 状态
        // 同时重置 heldAt：持有权从此刻起属于新持有者
        lock.heldAt = Date.now();
        next();
      } else {
        lock.held = false;
        lock.heldAt = null;
        this.locks.delete(key);
      }
    };
  }

  /** 等待锁释放或超时（#599 自 acquire 拆出：保持 acquire 主流程可读性） */
  private async waitForLock(
    key: string,
    lock: { heldAt: number | null; waiters: Array<() => void> },
    timeout: number,
    waitStartedAt: number,
  ): Promise<void> {
    // Why: 清理超时等待者 —— 防止 timeout 后 resolve 仍留在队列中被意外唤醒
    let waiterResolve: (() => void) | undefined;
    await Promise.race([
      new Promise<void>(resolve => {
        waiterResolve = resolve;
        lock.waiters.push(resolve);
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          if (waiterResolve) {
            const idx = lock.waiters.indexOf(waiterResolve);
            if (idx !== -1) lock.waiters.splice(idx, 1);
          }
          // Why(#423 方案1): 超时是静默故障——错误被抛出后若无调用方记录，
          // 事故侧只能看到报错文本，无法定位持有者是谁、持有了多久。
          // 此处落结构化日志，把可得的诊断证据（持有者、持有时长、队列深度）留下。
          // 边界说明：healing event 上报需要 messageId/conversationId（schema NOT NULL），
          // 该层不可得，故不上报 healing event——由本日志驱动方案 2 的根因诊断。
          const now = Date.now();
          this.logger?.error(
            `Lock acquire timeout for key: ${key}`,
            new SessionLockConflictError(`Lock acquire timeout for key: ${key}`),
            {
              module: 'SimpleLockManager',
              lockKey: key,
              /** key 形如 session:<otterId>，解析出 otterId 便于按獭聚合排查 */
              otterId: key.startsWith('session:') ? key.slice('session:'.length) : undefined,
              waitedMs: now - waitStartedAt,
              timeoutMs: timeout,
              /** 持有者已持有该锁的时长（ms）；null 表示状态不可考（如 destroy 后重建） */
              holderHeldForMs: lock.heldAt !== null ? now - lock.heldAt : null,
              /** #599：steal 阈值——对照 holderHeldForMs 可判断本超时是否本应被 steal 兜住 */
              stealThresholdMs: this.stealThresholdMs,
              /** 超时发生时仍在排队的等待者数量（不含本次） */
              queueLength: lock.waiters.length,
              /** 当前活跃锁总数（进程级锁竞争强度信号） */
              activeLocks: this.locks.size,
            },
          );
          reject(new SessionLockConflictError(`Lock acquire timeout for key: ${key}`));
        }, timeout)
      ),
    ]);
  }

  destroy(): void {
    // 唤醒所有等待者，避免程序挂起
    for (const lock of this.locks.values()) {
      for (const resolve of lock.waiters) {
        resolve();
      }
    }
    this.locks.clear();
  }
}

/** SessionManager 相关的类型辅助 */
export type SessionManagerClass = {
  create: (cwd: string, sessionDir?: string, options?: { parentSession?: string }) => SessionManager;
  open: (path: string, sessionDir?: string, cwdOverride?: string) => SessionManager;
  inMemory: () => SessionManager;
};

/** 从 piCodingAgent 模块获取 SessionManager */
export function getSessionManagerClass(piCodingAgent: unknown): SessionManagerClass {
  return (piCodingAgent as unknown as { SessionManager: SessionManagerClass }).SessionManager;
}

/**
 * 构建 Otter 提示（支持字符串或 OtterPromptConfig）。
 * OtterPromptConfig 包含 systemPrompt 和 reminders，需按优先级排序后拼接。
 */
export function buildOtterPrompt(config: string | OtterPromptConfig | undefined): string {
  if (!config) return "";
  if (typeof config === "string") return config;

  const parts: string[] = [];
  if (config.systemPrompt) {
    parts.push(config.systemPrompt);
  }

  /** System reminders（按优先级排序） */
  if (config.reminders && config.reminders.length > 0) {
    const sorted = [...config.reminders]
      .sort((a, b) => {
        const weightA = a.priority === "high" ? 0 : a.priority === "medium" ? 1 : 2;
        const weightB = b.priority === "high" ? 0 : b.priority === "medium" ? 1 : 2;
        return weightA - weightB;
      });
    for (const reminder of sorted) {
      parts.push(`<system-reminder>\n${reminder.content}\n</system-reminder>`);
    }
  }

  return parts.join("\n\n");
}

/**
 * 构建包含动态上下文的用户消息。
 * S1（R20260810piab）：system prompt（otterPrompt + identity）已改由 extension
 * before_agent_start handler 注入 system role，不再拼在 user message 里。
 * staticPrompt 参数保留但调用方传空串（向后兼容签名，后续可清理）。
 */
// eslint-disable-next-line complexity -- F20260826mwrd C3：+healingAlerts 渲染分支（借用式注入面汇聚处，拆分反而降低内聚）
export function buildMessageWithContext(
  staticPrompt: string,
  message: string,
  dynamicContext?: DynamicContext,
): string {
  const parts: string[] = [];

  if (staticPrompt) {
    parts.push(staticPrompt);
  }

  if (dynamicContext?.sessionSummary) {
    parts.push(`## 会话摘要\n${dynamicContext.sessionSummary}`);
  }

  // F20260825hndf：件②文件轨迹（借用式，消费即删）
  if (dynamicContext?.fileTrail) {
    parts.push(dynamicContext.fileTrail);
  }

  // F20260825hndf：件③近期原文（借用式，消费即删）
  if (dynamicContext?.recencyWindow) {
    parts.push(dynamicContext.recencyWindow);
  }

  // F20260825hndf：件④活状态盘点（借用式，消费即删）
  if (dynamicContext?.stateInventory) {
    parts.push(dynamicContext.stateInventory);
  }

  // F20260826mwrd C3（Part 4）：高危 healing 事件提醒（借用式，消费即删）。
  // 位置在 workspacePath 之后、用户消息之前——提醒属环境情报而非任务本体。
  if (dynamicContext?.healingAlerts) {
    parts.push(dynamicContext.healingAlerts);
  }

  if (dynamicContext?.workspacePath) {
    parts.push(`## 对话工作区\n你的对话工作区路径：${dynamicContext.workspacePath}\n使用 workspace_* 工具操作工作区文件。研究报告、临时文件等持久化内容请写入工作区。`);
  }

  parts.push(message);

  return parts.join("\n\n");
}
