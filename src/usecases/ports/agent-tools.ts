/**
 * Agent 工具领域接口（已拍板）。
 *
 * 工具是"给 LLM 的手脚"，其契约（AgentTool/ToolContext/ToolResponse）是应用层概念——
 * interface-adapters（工具实现与文案）与 frameworks（pi-session-factory 装载）双方
 * 都可依赖本 port（外层依内层）。此前这组类型定义在 interface-adapters，导致
 * pi-session-factory 反向 import interface-adapters（分层倒穿）；truncateToolResult
 * 及其返回类型 ToolResponse 从 tools/tool-helpers.ts 随迁至此。
 *
 * ToolContext 的 pendingRestart / getTurnAssistantText 字段携带 SDK 会话生命周期协议
 * 语义（由 session 工厂消费/维护）。2026-11-09 已切 pi-durable：工厂侧适配已落
 * （durable-session），本 port 形态不再随 SDK 直接变化；完整边界见 docs/designs/runtime-contract.md。
 */
import type { OtterToolClient } from "./otter-tool-client";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import type { SignalRepository } from "@usecases/health/signal-repository";
import type { MatterRepository } from "@usecases/matter/matter-repository";
import type { WorkLedgerBinder } from "@usecases/health/work-ledger-binder";
import type { ModelPoolLike } from "./model-pool-like";
import type { OtterConfigProvider } from "./otter-config-provider";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Readable } from "node:stream";

/**
 * 工具层的模型池窄接口：工具只做 modelAlias 校验与列举，
 * 不需要默认模型切换/全量信息。具体 ModelPool 结构化兼容，无需 adapter。
 * 取代 tool-factory 内的重复 ModelPoolLike 定义（双定义消除）。
 */
export type ToolModelPool = Pick<ModelPoolLike, "hasModel" | "describeModels"> & {
  /** create_otter 注入体积预算检查需要窗口查询；可选（旧装配/测试桩未带时 fail-soft 跳过） */
  getContextWindow?: (alias?: string) => number | undefined;
};

/** Tool 执行结果（Pi AgentTool 格式） */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  /**
   * 错误标志。
   * SDK 的 AgentToolResult 不直接消费此字段——otter-hooks 的 tool_result extension handler
   * 把它复制到 details.__isError，再由 handler 返回 { isError: true } 覆盖 SDK 的 isError 标志，
   * 从而透传到 Anthropic API 的 tool_result.is_error。
   */
  isError?: boolean;
  /** 置 true 时 agent loop 在本批次工具执行后终止，不再发起下一轮 LLM 调用（Pi 原生能力） */
  terminate?: boolean;
}

export function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * 错误返回工厂。
 * 文案保留 `[错误]` 前缀（人类可读），同时设 isError=true（机器可识别）。
 * 经 otter-hooks tool_result handler 透传到 Anthropic API 的 is_error 字段。
 */
export function errorResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}

/** 单个 tool result 最大字符数（~4K tokens，防止巨量结果污染上下文导致模型退化） */
export const MAX_TOOL_RESULT_CHARS = 15_000;

/**
 * 截断过大的 tool result，防止上下文膨胀导致模型退化。
 * 策略：超过阈值时智能截断（JSON 模式保留完整条目），附加截断提示。
 */
export function truncateToolResult(result: ToolResponse): ToolResponse {
  return {
    ...result,
    content: result.content.map(c => {
      if (c.type !== "text" || c.text.length <= MAX_TOOL_RESULT_CHARS) return c;
      const truncated = smartTruncate(c.text, MAX_TOOL_RESULT_CHARS);
      return {
        type: "text" as const,
        text: `${truncated}\n\n[结果已截断，请缩小查询范围或使用分段参数获取完整内容。]`,
      };
    }),
  };
}

/**
 * 智能截断：JSON 数组在条目边界截断，其他文本在字符边界截断。
 * 支持顶级数组 `[...]` 和嵌套结构 `{"data": [...]}`
 */
function smartTruncate(text: string, maxChars: number): string {
  const trimmed = text.slice(0, maxChars);
  // 找到 JSON 数组起始位置（顶级或嵌套）
  const arrStart = trimmed.indexOf("[");
  if (arrStart >= 0 && arrStart < 100) {
    const lastEntryEnd = trimmed.lastIndexOf("},");
    if (lastEntryEnd > arrStart) {
      return trimmed.slice(0, lastEntryEnd + 1) + "\n]";
    }
    const lastClose = trimmed.lastIndexOf("}");
    if (lastClose > arrStart) {
      return trimmed.slice(0, lastClose + 1) + "\n]";
    }
  }
  return trimmed;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 执行工具。
   * signal 透传 SDK 的 AbortSignal——用户中断时工具可检查 signal.aborted 提前返回。
   * 大多数工具不需要中断（执行快），signal 参数可选；长耗时工具（如 workspace_* 操作大文件）应定期检查。
   */
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResponse>;
  [key: string]: unknown;
}

/**
 * 工具上下文：invoke 时由系统注入，闭包捕获。
 * otterId、conversationId 由系统注入，LLM 不传。
 *
 * （session 池化）：session 常驻后工具闭包跨 invoke 复用，
 * 「每 invoke 必变」的字段从值捕获改为 getter 引用（invoke 入口统一重置寄存器）。
 * conversationId 同样 getter 化——池 key 保持 otterId，同一常驻 session 可在 A→B
 * invoke 间复用；普通 transcript 仍为 otter-global，工具副作用必须读取本轮 B。
 */
export interface ToolContext {
  client: OtterToolClient;
  otterId: string;
  conversationId: string;
  /**
   * 本对话搭档（用户）id——belief preference 来源身份校验用。
   * Web 端缺省 "user"（PartnerResolver 同口径：Web senderId 恒为 user）；
   * IM 平台由装配层注入实际 owner id（open_id/ilink_user_id）。
   */
  partnerUserId?: string;
  /**
   * 受限外部会话（多用户外部平台经由扩展适配器接入）：本 invoke 的一切工具副作用必须收在"本对话边界"内。
   * 消费点：speak 只收 body、不落 healing/signal、不自动登记活类卡；
   * yield 只允许 to:['user']、不登记 matter、不计检视轮次。
   * 由 session 工厂按 externalProfile === 'restricted' 注入（invoke 级、不可由工具层抬升）。
   */
  externalRestricted?: boolean;
  /** getter 化（池化后跨 invoke 复用，invoke 入口重置寄存器）。
   *  读取时机 = 工具执行时（invoke 运行期内），寄存器必有值。 */
  readonly currentMessageId: string;
  /** 模型池（多模型路由，可选，用于校验 modelAlias） */
  modelPool?: ToolModelPool;
  /** Otter 配置提供者（用于查询其他獭的 modelAlias） */
  otterConfigProvider?: OtterConfigProvider;
  /**
   * 当前 assistant 消息的文本（speak 之外的输出）。
   * 由 session 工厂按消息维护（message_start 清零、message_end 累积）；speak 用它检测"卡片写在 speak 外"的错误用法。
   */
  getTurnAssistantText?: () => string;
  /**
   * 自重启时由 restart_otter 工具设置。
   * PiSessionFactory 在 session.prompt() 返回后检查并执行重启。
   * 扩展 modelAlias 字段——配额耗尽时应急切模型，透传到 agent-invoker。
   * Why: session.prompt() 是原子的，中途无法替换 session；
   * 延迟到 prompt 完成后执行，消息生命周期不受影响。
   */
  /** synthesizePast 透传（restart_otter 工具参数→自重启统一交接） */
  pendingRestart?: { conversationId: string; summary?: string; modelAlias?: string; synthesizePast?: boolean };
  /**
   * 本轮待派工票据（otterId → otterName）。
   * create_otter 创建后注册；speak 派工后清除已覆盖的；未清空时 speak 给一次软提醒（非阻断）。
   * agent invoke 级生命周期（每次 invoke 新建）。可选——未注入时 no-op。
   */
  pendingDispatches?: Map<string, string>;
  /** 本轮是否已展示过派工提醒。避免软守卫死循环——首次提醒后二次 speak 放行。 */
  dispatchWarningShown?: boolean;
  /** 本轮是否已展示过编排守卫提醒。二次放行——首次提醒后再次调用 write/edit/bash 放行。 */
  orchestrationWarningShown?: boolean;
  /** signal_events 仓库（halt_otter/query_signals 注册条件；invoke 级注入） */
  signalRepo?: SignalEventRepository;
  /** matters 仓库（待办——list_matters/transition_matter 注册条件；invoke 级注入） */
  matterRepo?: MatterRepository;
  /** RHI 健康信号仓库（signals 表——triage_signal/list_rhi_signals 注册条件） */
  rhiSignalRepo?: SignalRepository;
  /** 工作账本 binder（track_work 工具注册条件；invoke 级注入） */
  workLedgerBinder?: WorkLedgerBinder;
  /** 附件上传管线（upload_device_file 工具依赖；装配层注入。缺省 = 工具不注册）。 */
  attachmentUpload?: {
    upload(input: {
      stream: Readable;
      originalName: string;
      declaredMimeType: string;
      uploaderId: string;
    }): Promise<{
      id: string;
      kind: string;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      filePath: string;
    }>;
  };
  /** 对话执行机 env 解析（与 DurableSession env 工厂同链路——resolveForConversation →
   *  createExecutionEnvironment；upload_device_file 经它读设备字节。缺省 = 工具不注册）。 */
  resolveExecutionEnv?: (conversationId: string) => Promise<ExecutionEnv>;
  /** 当前打开的 speak entry ID（speak/yield 检测本轮已发言用）。
   * 池化合流：getter 化穿透寄存器（invoke 入口重置） */
  lastSpeakMessageId?: string;

  /** PR 呈递三件套守卫（回合寄存器）：本回合 speak 中出现过的 GitHub PR URL，
   *  分强信号（独占段，unfurl 口径）/弱信号（句中等形态）——yield 边界复核台账，
   *  缺席拒绝顶回（缺口快照比对，详见 turnYieldPrGapSnapshot）。invoke 入口重置。 */
  turnPrUrls?: { strong: string[]; weak: string[]; registered: string[] };
  /** yield 边界 PR 守卫的拒绝计数（观测用）。invoke 入口重置。 */
  turnYieldPrRemindCount?: number;
  /** yield 边界 PR 守卫的缺口快照（上次拒绝时缺口序列化，与当前相同 = 零进展
   *  放行防死循环；不同 = 拒绝并附完整缺口回执）。invoke 入口重置。 */
  turnYieldPrGapSnapshot?: string | null;

  /** PR 卡片闸事故 PR 呈递拍板机械闸：本回合 speak body 累计（yield 主闸的判定面——防拆条规避：
   * 先说「检视完了」再说「可以合入了」单条不共现，累计才能拼出呈递形态）。
   *  invoke 级生命周期（与 lastSpeakMessageId 同步重置；重启归零后 yield 先被「尚未落账 speak」拦，
   *  补 speak 即重新累计，两闸自洽）。 */
  speakBodiesThisTurn?: string[];
  /** 当前 invoke ID（invoke 级上下文）。合流：getter 化穿透寄存器 */
  currentInvokeId?: string;
  /** SSE 发射通道（工具层发 entry.yield 等事件用）。寄存器穿透 */
  emitEvent?: (event: { event: string; data: Record<string, unknown> }) => void;
  /** 目标獭活跃性查询（halt_otter 打标前检查——不在执行中则拒绝打标，从入口杜绝孤儿指令）。
   *  PiSessionFactory.isRunning 同源（activeSessions 查询），invoke 生命周期语义一致。 */
  isOtterRunning?: (otterId: string) => boolean;
}
