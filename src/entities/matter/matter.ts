/**
 * Matter 实体（F20261005mtlp P1）。
 *
 * 待办——per-conversation 承诺台账的一等实体。对话流是通信不是承诺：
 * matter 把「未完成之事」从消息流升格为带状态机的持续工作单元。
 *
 * 设计依据：docs/features/2026/10/05/F20261005mtlp-matter-loop-closure.md
 * §1 实体模型（字段表）+ §2 状态机（迁移矩阵 + 等待方生命周期规则）。
 *
 * 与 signal_event 的分工（F20260826mwrd）：signal = 瞬时协调信号（objection/blocked/halt），
 * matter = 持续工作单元（有 owner、有生命周期、有宣告权分权）——同构先例，不同物。
 */

/** 决策分级（沿用 F20260909debr 轴；L0 不产生 matter——准入白名单三条均产生不了 L0） */
export type MatterLevel = 'L1' | 'L2';

/**
 * 状态机当前态（§2 五存续态 + 两终态出口）。
 * 合法迁移矩阵见 matter-transitions.ts——未列入矩阵的迁移一律非法，
 * usecase 单入口（transition-matter.ts）拒绝。
 */
export type MatterState =
  | 'OPEN'                    /** 已登记待认领（「回头再说」/跨日未收尾任务入此态） */
  | 'WAITING_OTTER'           /** 獭处理中（waiting_on=otter:<id>） */
  | 'WAITING_PARTNER'         /** 待搭档裁决（L2 显式拍板项生而此态） */
  | 'DONE_PENDING_CONFIRM'    /** 獭宣称完成，等闭环确认 */
  | 'CLOSED'                  /** 终态：已闭环 */
  | 'SUPERSEDED'              /** 终态：被新 matter 取代 */
  | 'ABANDONED';              /** 终态：搭档明确不做 */

/** 存续态集合（终态出口 = CLOSED / SUPERSEDED / ABANDONED） */
export const MATTER_OPEN_STATES: readonly MatterState[] = [
  'OPEN',
  'WAITING_OTTER',
  'WAITING_PARTNER',
  'DONE_PENDING_CONFIRM',
];

/**
 * 当前在等谁：
 * - 'partner'：等搭档（裁决/确认闭环）
 * - 'otter:<id>'：等指定獭（续办）
 * - 'none'：无明确等待方
 */
export type MatterWaitingOn = string;

/** Matter 实体（字段严格按方案 §1 字段表） */
export interface Matter {
  id: string;
  conversationId: string;
  /** 一句话事情名 */
  title: string;
  /** 发起消息锚点（溯源回流；准入路径 3 的去重键） */
  originMessageId: string | null;
  /** 负责獭——打回/唤醒/重派三处路由依据（WAITING_PARTNER 态下保留） */
  ownerOtterId: string | null;
  level: MatterLevel | null;
  state: MatterState;
  waitingOn: MatterWaitingOn | null;
  /** 在等什么动作（一句话） */
  waitingFor: string | null;
  /** 决策请求挂点内容（L2 时 = 简报卡三层结构 JSON；真相在 payload，流内卡片是渲染投影） */
  payload: string | null;
  /** 裁决/闭环结果回写 */
  resolution: string | null;
  /** 闭环宣告者（partner / otter:<id>）——宣告权分权的可审计留痕 */
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** 按对话查询 matter 的过滤条件 */
export interface MatterQueryFilter {
  state?: MatterState;
  /** 查询 open 列表（P1 右侧栏只读 tab + 机械供料数据源） */
  openOnly?: boolean;
  ownerOtterId?: string;
  waitingOn?: string;
}
