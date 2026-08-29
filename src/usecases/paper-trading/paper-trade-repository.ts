/**
 * 纸面交易仓储接口
 * 
 * 定义账本引擎的数据访问层
 */

import type {
  PaperAccount,
  PaperPosition,
  PaperOrder,
  PaperTrade,
  PaperNavHistory,
  PaperReport,
  OrderSide,
  OrderStatus,
} from '@entities/paper-trading';

export interface PaperTradeRepository {
  // ==================== 账户 ====================
  createAccount(account: PaperAccount): Promise<void>;
  getAccount(accountId: string): Promise<PaperAccount | null>;

  // ==================== 持仓 ====================
  createPosition(accountId: string, code: string, shares: number, avgCost: number): Promise<void>;
  updatePosition(accountId: string, code: string, shares: number, avgCost: number): Promise<void>;
  deletePosition(accountId: string, code: string): Promise<void>;
  getPosition(accountId: string, code: string): Promise<PaperPosition | null>;
  getPositions(accountId: string): Promise<PaperPosition[]>;

  // ==================== 现金 ====================
  getCash(accountId: string): Promise<number>;
  updateCash(accountId: string, cash: number): Promise<void>;

  // ==================== 订单 ====================
  createOrder(order: PaperOrder): Promise<void>;
  getOrder(orderId: string): Promise<PaperOrder | null>;
  getOrders(accountId: string): Promise<PaperOrder[]>;
  getPendingOrders(accountId: string): Promise<PaperOrder[]>;
  updateOrderStatus(orderId: string, status: OrderStatus, rejectReason: string | null): Promise<void>;
  findExistingOrder(
    accountId: string,
    code: string,
    side: OrderSide,
    shares: number,
    date: string,
  ): Promise<PaperOrder | null>;
  getTodayOrderCount(accountId: string, date: string): Promise<number>;
  getLastBuyDate(accountId: string, code: string, beforeDate: string): Promise<string | null>;

  // ==================== 成交 ====================
  createTrade(trade: PaperTrade): Promise<void>;
  getTrades(accountId: string): Promise<PaperTrade[]>;
  getTradesByDate(accountId: string, date: string): Promise<PaperTrade[]>;

  // ==================== 净值 ====================
  createNavHistory(nav: PaperNavHistory): Promise<void>;
  getNavHistory(accountId: string): Promise<PaperNavHistory[]>;
  getNavHistory(accountId: string, date: string): Promise<PaperNavHistory | null>;
  getLatestNav(accountId: string): Promise<PaperNavHistory | null>;

  // ==================== 报告 ====================
  createReport(report: PaperReport): Promise<void>;
  getReport(accountId: string, date: string): Promise<PaperReport | null>;

  // ==================== 交易日历 ====================
  isTradingDay(date: string): Promise<boolean>;
  getTradingDays(startDate: string, endDate: string): Promise<string[]>;

  // ==================== 除权标记 ====================
  markCorporateAction(code: string, date: string): Promise<void>;
}
