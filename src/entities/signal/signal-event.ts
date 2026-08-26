/**
 * Signal Event 实体（F20260826mwrd C1）。
 *
 * 獭间结构化信号的持久化台账。C1 落地 halt 类型（大獭停小獭的审计记录），
 * C2 起 objection/blocked 经 signal-parser 入库，共享同一表。
 *
 * 设计依据：docs/features/2026/08/26/F20260826mwrd.md Part 2 数据模型。
 * 与 healing_events 分池的理由见该文档「为什么不复用 healing_events 表」。
 */

/** 信号类型 */
export type SignalType =
  | 'objection' /** 小獭对派工的事实性异议（须含文档锚点/file:line） */
  | 'blocked'   /** 小獭卡住升级（须附已试清单） */
  | 'halt';     /** 大獭/搭档对目标獭的停手指令（C1） */

/** 信号严重程度 */
export type SignalSeverity = 'low' | 'medium' | 'high';

/** 信号状态机：halt 落账即 completed 语义（见 haltOtterStatusNote）；objection/blocked 走裁决闭环（C2） */
export type SignalStatus = 'pending' | 'resolved' | 'dismissed';

/**
 * halt 的状态语义说明：
 * 方案文档 Part 3 规定 halt 事件落账 status=completed——本实现以 'resolved' 表达
 * 「指令已投递、无待裁决事项」（复用现有状态枚举，不为 halt 单造 completed 态，
 * 避免 C2 状态机分叉）。resolvedBy=发起者，resolution=halt 指令摘要。
 */

/** Signal event 实体 */
export interface SignalEvent {
  id: string;
  conversationId: string;
  /** 触发信号的消息（halt=halt_otter 工具调用所在消息；objection/blocked=携带 <signal> 块的 speak 消息） */
  messageId: string;
  /** 信号发起者 otterId（halt=发起停手的獭；objection/blocked=发信号的獭） */
  fromOtterId: string;
  /** halt 专属：被停目标 otterId。UI「谁停了谁」的一等查询维度（方案表结构微调，见特性文档 C1 实现记录） */
  targetOtterId: string | null;
  type: SignalType;
  severity: SignalSeverity;
  /** 信号正文：halt=停手理由；objection=事实依据；blocked=卡点+已试清单 */
  payload: string;
  status: SignalStatus;
  /** 裁决/处置文本 */
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** 按 conversation 查询信号的过滤条件 */
export interface SignalQueryFilter {
  type?: SignalType;
  status?: SignalStatus;
  fromOtterId?: string;
  targetOtterId?: string;
}
