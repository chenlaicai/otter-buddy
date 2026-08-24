/**
 * Session 复用相关的辅助函数和类
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OtterPromptConfig } from "@contract/api/otter";
import type { DynamicContext } from "@usecases/ports/sdk-invoke-port";
import { loadToolManifest, getToolNamesFromManifest } from "../config/tool-manifest-loader";

/**
 * 按 otterType 获取编码工具列表。
 * big otter 和 small otter 均启用全部编码工具（read/write/edit/bash）。
 * Why: small otter 需要写代码（开发獭）、评论 PR（检视獭）、执行构建命令等实际工作，
 * 只给 read 会导致它们无法完成任务。管理类工具的隔离在 getOtterToolNamesForType 中控制。
 */
export function getCodingToolsForOtterType(_otterType: string | undefined): string[] {
  // big 和 small otter 均启用全部编码工具
  return ["read", "write", "edit", "bash"];
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
   *  restart_otter 工具内部有访问控制：小獭只能重启自己。 */
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
  ];
}

/**
 * 简单的锁管理器，使用队列实现，避免竞态条件。
 *
 * Why: 显式跟踪 held 状态 —— 旧版仅检查 waiters 队列长度，
 * 第一个获取锁的人不入队，导致第二个调用者也看到队列为空而直接获锁，
 * 两个操作并发执行（EEXIST 竞态条件的根因，见 #376）。
 */
export class SimpleLockManager {
  private locks = new Map<string, { held: boolean; waiters: Array<() => void> }>();
  private readonly defaultTimeout: number;

  constructor(timeoutMs: number = 30000) {
    this.defaultTimeout = timeoutMs;
  }

  async acquire(key: string, timeoutMs?: number): Promise<() => void> {
    const timeout = timeoutMs ?? this.defaultTimeout;
    let lock = this.locks.get(key);
    if (!lock) {
      lock = { held: false, waiters: [] };
      this.locks.set(key, lock);
    }

    // Why: 检查 held（非 waiters.length）—— 第一个获取者不会入队，
    // 旧版检查队列长度导致两个调用者都绕过等待。
    if (lock.held) {
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
            reject(new Error(`Lock acquire timeout for key: ${key}`));
          }, timeout)
        ),
      ]);
    }

    lock.held = true;

    // Why: released 标志防止 double release（调用方意外多次调用 release 函数）
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = lock.waiters.shift();
      if (next) {
        // Why: 保持 held=true —— 锁转移给下一个等待者，不经过 unheld 状态
        next();
      } else {
        lock.held = false;
        this.locks.delete(key);
      }
    };
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

  if (dynamicContext?.workspacePath) {
    parts.push(`## 对话工作区\n你的对话工作区路径：${dynamicContext.workspacePath}\n使用 workspace_* 工具操作工作区文件。研究报告、临时文件等持久化内容请写入工作区。`);
  }

  parts.push(message);

  return parts.join("\n\n");
}
