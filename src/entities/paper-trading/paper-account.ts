/**
 * 纸面交易账户实体
 * 
 * 券商边界原则：账本引擎 = 固定代码（撮合/持仓/收益/净值），AI 无任何工具可篡改
 */

/** 订单方向 */
export type OrderSide = 'buy' | 'sell';

/** 订单状态 */
export type OrderStatus = 'pending' | 'filled' | 'rejected' | 'expired';

/** 报告类型 */
export type ReportType = 'daily' | 'weekly';

/** 账户状态 */
export type AccountStatus = 'active' | 'suspended';

/** 纸面交易账户 */
export interface PaperAccount {
  id: string;
  initialCash: number;
  status: AccountStatus;
  createdAt: string;
}

/** 持仓 */
export interface PaperPosition {
  accountId: string;
  code: string;
  shares: number;
  avgCost: number;
  updatedAt: string;
}

/** 订单 */
export interface PaperOrder {
  id: string;
  accountId: string;
  code: string;
  side: OrderSide;
  shares: number;
  reason: string;
  createdAt: string;
  status: OrderStatus;
  rejectReason: string | null;
}

/** 成交记录 */
export interface PaperTrade {
  orderId: string;
  code: string;
  side: OrderSide;
  shares: number;
  price: number;
  fee: number;
  tradeDate: string;
  executedAt: string;
}

/** 净值历史 */
export interface PaperNavHistory {
  accountId: string;
  date: string;
  cash: number;
  marketValue: number;
  total: number;
  nav: number;
}

/** 日报/周报存档 */
export interface PaperReport {
  id: string;
  date: string;
  type: ReportType;
  numbersMd: string;
  createdAt: string;
}

/** 交易日历 */
export interface TradingCalendar {
  date: string;
  isTradingDay: boolean;
  year: number;
}

/** 账户快照（只读查询用） */
export interface AccountSnapshot {
  cash: number;
  positions: Array<{
    code: string;
    shares: number;
    avgCost: number;
    currentPrice: number;
    marketValue: number;
  }>;
  total: number;
  nav: number;
}

/** 订单查询结果 */
export interface OrderWithTrade extends PaperOrder {
  trade: PaperTrade | null;
}
