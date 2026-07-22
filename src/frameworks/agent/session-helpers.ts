/**
 * Session 复用相关的辅助函数和类
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OtterPromptConfig } from "@contract/api/otter";
import type { DynamicContext } from "@interface-adapters/agent-runtime/agent-invoke-port";

/**
 * 按 otterType 获取编码工具列表。
 * big otter 启用全部编码工具，small otter 不启用编码工具。
 */
export function getCodingToolsForOtterType(otterType: string | undefined): string[] {
  if (!otterType || otterType === "big") {
    return ["read", "write", "edit", "bash"];
  }
  /** small otter 不需要编码工具 */
  return [];
}

/**
 * 按 otterType 获取 Otter 自定义工具名称白名单。
 * big otter 拥有全部工具，small otter 只有消息和记忆相关工具。
 */
export function getOtterToolNamesForType(otterType: string | undefined): string[] {
  const allToolNames = [
    "speak", "pass_talking_stone", "search_memory",
    "create_otter", "dissolve_otter", "create_linked_resource", "get_memory_detail",
    "get_message", "list_messages", "search_messages", "get_turn_history",
    "get_context", "set_context", "delete_context",
    "search_terminology", "add_terminology",
    "list_artifacts", "update_artifact_status",
    "get_active_participants",
  ];

  if (!otterType || otterType === "big") {
    return allToolNames;
  }

  /** small otter：消息检索 + 记忆 + 上下文 + 术语库 + 产物管理 + 参与者查询，不含管理类工具 */
  return [
    "speak", "search_memory", "create_linked_resource", "get_memory_detail",
    "get_message", "list_messages", "search_messages", "get_turn_history",
    "get_context", "set_context", "delete_context",
    "search_terminology", "add_terminology",
    "list_artifacts", "update_artifact_status",
    "get_active_participants",
  ];
}

/** 简单的锁管理器，使用队列实现，避免竞态条件 */
export class SimpleLockManager {
  private queues = new Map<string, Array<() => void>>();

  async acquire(key: string): Promise<() => void> {
    const queue = this.queues.get(key) ?? [];
    this.queues.set(key, queue);

    // 如果队列不为空，等待前一个锁释放
    if (queue.length > 0) {
      await new Promise<void>(resolve => queue.push(resolve));
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
 * 构建包含系统提示和动态上下文的消息。
 * 系统提示作为用户消息前缀注入（SDK 的 systemPrompt 由 ResourceLoader 内部管理，
 * 无公开 API 覆盖；冷启动模型下 session 无持久 system prompt）。
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

  parts.push(message);

  return parts.join("\n\n");
}
