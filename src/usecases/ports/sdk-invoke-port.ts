/**
 * SDK 级 Agent 调用端口（R20260817arnt PR-A：自 interface-adapters/agent-runtime/agent-invoke-port.ts
 * 改名上移，消除与 usecases/ports/agent-invoke-port.ts 的同名双定义——那边是 invokeConversation
 * 粒度、PR-D1 时删除；本接口是 SDK invoke 粒度，PiSessionFactory 结构匹配）。
 *
 * ⚠️ 本 port 依赖 pi-coding-agent 的 AgentSessionEvent 类型（re-export）——换 SDK 时需修订。
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Agent 流式事件。
 *
 * 保持弱类型 + 索引签名（兼容现有消费方 + 测试 mock）。需要 discriminated union 精确 narrowing
 * 时用 re-export 的 `AgentSessionEvent`（SDK 联合类型，要求 AgentMessage 完整字段，适合生产路径）。
 *
 * R20260810piab 遗漏 1：移除了死字段 `delta`——message_update 被 createEventHandler 过滤，
 * onEvent 永远收不到；delta 实际在 assistantMessageEvent 内层（output-guard.ts 直连 subscribe 提取）。
 */
export interface AgentStreamEvent {
  type: string;
  [key: string]: unknown;
}

/** Re-export SDK 精确类型，供需要 discriminated union narrowing 的消费方使用 */
export type { AgentSessionEvent };

/** Agent 执行结果（与 Pi 的 AgentRunResult 结构匹配） */
export interface AgentRunResult {
  text: string;
  /** session 累计 token 消耗（成本口径，仅日志用；不代表上下文窗口占用） */
  tokenUsage?: { input: number; output: number };
  /** 上下文窗口占用：末次 LLM 调用的 input+output+cacheRead+cacheWrite（F20260808ctxw） */
  ctxTokens?: number;
  ctxMax?: number;
  circuitBreakerMetadata?: { totalCalls: number; circuitReason?: string };
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number };
  /** 本次 invoke 实际使用的模型别名（F20260814mtrc：metrics model label 数据源） */
  modelAlias?: string;
  /** 本次 invoke 重建了全新 session（F20260814mtrc） */
  sessionRebuilt?: boolean;
  /** F20260819rscn: LLM 调用 restart_otter(self) 时，SDK 不执行 restart，改为标记信号由调用方处理 */
  _selfRestart?: { otterId: string; summary?: string };
  /** LLM 直出文本（未通过 speak 输出，对其他人不可见）。用于检测"旁白流失"失败形态 */
  directText?: string;
  /** 末条 assistant 消息的 stopReason（F20260903lngth：length=生成被 token 上限截断） */
  lastStopReason?: string;
}

/** 动态上下文（与 Pi 的 DynamicContext 结构匹配） */
export interface DynamicContext {
  sessionSummary?: string;
  /** 对话工作区绝对路径 */
  workspacePath?: string;
  /** F20260825hndf：件②文件轨迹（机械提取，借用式） */
  fileTrail?: string;
  /** F20260825hndf：件③近期原文片段（借用式，消费即删） */
  recencyWindow?: string;
  /** F20260825hndf：件④活状态盘点（机械 checklist，借用式） */
  stateInventory?: string;
  /** F20260826mwrd C3（Part 4）：高危 healing 事件提醒（渲染好的文本，借用式，消费即删） */
  healingAlerts?: string;
}

/** invoke() 选项 */
export interface InvokeOptions {
  dynamicContext?: DynamicContext;
  conversationId: string;
  /** 当前 streaming 消息 ID（speak 工具需要） */
  messageId?: string;
  onEvent?: (event: AgentStreamEvent) => void;
  /** 多模态 Phase 1：当前任务消息携带的图片（ImageContent：base64 data + mimeType）。
   *  策略在 usecases 组装（读盘 base64）；本 port 只透传机制。
   *  模型不支持 vision 时 SDK downgradeUnsupportedImages 自动降级占位符，otter 层不自判。 */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** F20260825hndf Phase 2：只读模式——跳过消息持久化和 SSE 广播，用于交接摘要合成。
   *  Pi SDK 无原生 read-only 支持，靠 prompt 约束 + 工具白名单实现。 */
  readOnly?: boolean;
}

export interface SdkInvokePort {
  invoke(otterId: string, message: string, options?: InvokeOptions): Promise<AgentRunResult>;
  /** 中断指定 Otter 的 Agent 生成（messageId 用于定位并发 session） */
  abort(otterId: string, messageId?: string): void;
  /** 获取指定 Otter 当前 session 的工具调用次数 */
  getToolCallCount(otterId: string, messageId?: string): number;
  /** 查询内部 abort 原因（OutputGuard 触发等），返回 undefined 表示非内部 abort */
  getInternalAbortReason(messageId: string): string | undefined;
}
