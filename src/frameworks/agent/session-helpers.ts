/**
 * Session 复用相关的辅助函数和类
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OtterPromptConfig } from "@contract/api/otter";
import type { DynamicContext } from "@interface-adapters/agent-runtime/agent-invoke-port";

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
 * big otter 拥有全部工具，small otter 只有消息和记忆相关工具。
 */
export function getOtterToolNamesForType(otterType: string | undefined): string[] {
  const allToolNames = [
    "speak", "search_memory",
    "create_otter", "dissolve_otter", "restart_otter", "create_linked_resource", "get_memory_detail",
    "get_message", "list_messages", "search_messages", "get_turn_history",
    "get_context", "set_context", "delete_context",
    "search_terminology", "add_terminology",
    "list_artifacts", "update_artifact_status",
    "get_active_participants", "get_html_card_contract",
    "manage_healing_events",
    "create_scheduled_task",
    "workspace_info", "workspace_list", "workspace_read", "workspace_write",
    // F20260813mrel: 记忆关系层工具
    "link_memory", "get_related", "unlink_memory",
  ];

  if (!otterType || otterType === "big") {
    return allToolNames;
  }

  /** small otter：消息检索 + 记忆 + 上下文 + 术语库 + 产物管理 + 参与者查询 + 工作区 + 定时任务 + 自愈管理 + 自身重启，不含 Otter 管理类工具（create_otter/dissolve_otter）。
   *  restart_otter 工具内部有访问控制：小獭只能重启自己。 */
  return [
    "speak", "search_memory", "create_linked_resource", "get_memory_detail",
    "get_message", "list_messages", "search_messages", "get_turn_history",
    "get_context", "set_context", "delete_context",
    "search_terminology", "add_terminology",
    "list_artifacts", "update_artifact_status",
    "get_active_participants", "get_html_card_contract",
    "create_scheduled_task", "manage_healing_events",
    "restart_otter",
    "workspace_info", "workspace_list", "workspace_read", "workspace_write",
    // F20260813mrel: 记忆关系层工具（大小獭都能用）
    "link_memory", "get_related", "unlink_memory",
  ];
}

/** 简单的锁管理器，使用队列实现，避免竞态条件 */
export class SimpleLockManager {
  private queues = new Map<string, Array<() => void>>();
  private readonly defaultTimeout: number;

  constructor(timeoutMs: number = 30000) {
    this.defaultTimeout = timeoutMs;
  }

  async acquire(key: string, timeoutMs?: number): Promise<() => void> {
    const timeout = timeoutMs ?? this.defaultTimeout;
    const queue = this.queues.get(key) ?? [];
    this.queues.set(key, queue);

    // 如果队列不为空，等待前一个锁释放
    if (queue.length > 0) {
      await Promise.race([
        new Promise<void>(resolve => queue.push(resolve)),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`Lock acquire timeout for key: ${key}`)), timeout)
        ),
      ]);
    }

    // 返回释放函数
    return () => {
      const next = queue.shift();
      if (next) {
        next(); // 唤醒下一个等待者
      } else {
        this.queues.delete(key);
      }
    };
  }

  destroy(): void {
    // 唤醒所有等待者，避免程序挂起
    for (const queue of this.queues.values()) {
      for (const resolve of queue) {
        resolve();
      }
    }
    this.queues.clear();
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
