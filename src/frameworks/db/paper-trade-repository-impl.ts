/**
 * 纸面交易仓储 SQLite 实现
 */

import type Database from 'better-sqlite3';
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
import type { PaperTradeRepository } from '@usecases/paper-trading/paper-trade-repository';

export class PaperTradeRepositoryImpl implements PaperTradeRepository {
  constructor(private readonly db: Database.Database) {}

  // ==================== 账户 ====================

  async createAccount(account: PaperAccount): Promise<void> {
    this.db.prepare(`
      INSERT INTO paper_accounts (id, initial_cash, status, created_at)
      VALUES (?, ?, ?, ?)
    `).run(account.id, account.initialCash, account.status, account.createdAt);
  }

  async getAccount(accountId: string): Promise<PaperAccount | null> {
    const row = this.db.prepare(`
      SELECT id, initial_cash as initialCash, status, created_at as createdAt
      FROM paper_accounts WHERE id = ?
    `).get(accountId) as PaperAccount | undefined;
    return row || null;
  }

  // ==================== 持仓 ====================

  async createPosition(accountId: string, code: string, shares: number, avgCost: number): Promise<void> {
    this.db.prepare(`
      INSERT INTO paper_positions (account_id, code, shares, avg_cost, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(accountId, code, shares, avgCost);
  }

  async updatePosition(accountId: string, code: string, shares: number, avgCost: number): Promise<void> {
    this.db.prepare(`
      UPDATE paper_positions SET shares = ?, avg_cost = ?, updated_at = datetime('now')
      WHERE account_id = ? AND code = ?
    `).run(shares, avgCost, accountId, code);
  }

  async deletePosition(accountId: string, code: string): Promise<void> {
    this.db.prepare(`
      DELETE FROM paper_positions WHERE account_id = ? AND code = ?
    `).run(accountId, code);
  }

  async getPosition(accountId: string, code: string): Promise<PaperPosition | null> {
    const row = this.db.prepare(`
      SELECT account_id as accountId, code, shares, avg_cost as avgCost, updated_at as updatedAt
      FROM paper_positions WHERE account_id = ? AND code = ?
    `).get(accountId, code) as PaperPosition | undefined;
    return row || null;
  }

  async getPositions(accountId: string): Promise<PaperPosition[]> {
    return this.db.prepare(`
      SELECT account_id as accountId, code, shares, avg_cost as avgCost, updated_at as updatedAt
      FROM paper_positions WHERE account_id = ?
    `).all(accountId) as PaperPosition[];
  }

  // ==================== 现金 ====================

  async getCash(accountId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT cash FROM paper_cash WHERE account_id = ?
    `).get(accountId) as { cash: number } | undefined;
    return row?.cash ?? 0;
  }

  async updateCash(accountId: string, cash: number): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO paper_cash (account_id, cash, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(accountId, cash);
  }

  // ==================== 订单 ====================

  async createOrder(order: PaperOrder): Promise<void> {
    this.db.prepare(`
      INSERT INTO paper_orders (id, account_id, code, side, shares, reason, created_at, status, reject_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      order.id, order.accountId, order.code, order.side, order.shares,
      order.reason, order.createdAt, order.status, order.rejectReason,
    );
  }

  async getOrder(orderId: string): Promise<PaperOrder | null> {
    const row = this.db.prepare(`
      SELECT id, account_id as accountId, code, side, shares, reason,
             created_at as createdAt, status, reject_reason as rejectReason
      FROM paper_orders WHERE id = ?
    `).get(orderId) as PaperOrder | undefined;
    return row || null;
  }

  async getOrders(accountId: string): Promise<PaperOrder[]> {
    return this.db.prepare(`
      SELECT id, account_id as accountId, code, side, shares, reason,
             created_at as createdAt, status, reject_reason as rejectReason
      FROM paper_orders WHERE account_id = ? ORDER BY created_at DESC
    `).all(accountId) as PaperOrder[];
  }

  async getPendingOrders(accountId: string): Promise<PaperOrder[]> {
    return this.db.prepare(`
      SELECT id, account_id as accountId, code, side, shares, reason,
             created_at as createdAt, status, reject_reason as rejectReason
      FROM paper_orders WHERE account_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(accountId) as PaperOrder[];
  }

  async updateOrderStatus(orderId: string, status: OrderStatus, rejectReason: string | null): Promise<void> {
    this.db.prepare(`
      UPDATE paper_orders SET status = ?, reject_reason = ? WHERE id = ?
    `).run(status, rejectReason, orderId);
  }

  async findExistingOrder(
    accountId: string,
    code: string,
    side: OrderSide,
    shares: number,
    date: string,
  ): Promise<PaperOrder | null> {
    const row = this.db.prepare(`
      SELECT id, account_id as accountId, code, side, shares, reason,
             created_at as createdAt, status, reject_reason as rejectReason
      FROM paper_orders
      WHERE account_id = ? AND code = ? AND side = ? AND shares = ?
        AND date(created_at) = ? AND status IN ('pending', 'filled')
      LIMIT 1
    `).get(accountId, code, side, shares, date) as PaperOrder | undefined;
    return row || null;
  }

  async getTodayOrderCount(accountId: string, date: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM paper_orders
      WHERE account_id = ? AND date(created_at) = ?
    `).get(accountId, date) as { count: number };
    return row.count;
  }

  async getLastBuyDate(accountId: string, code: string, beforeDate: string): Promise<string | null> {
    const row = this.db.prepare(`
      SELECT trade_date as tradeDate FROM paper_trades
      WHERE code = ? AND side = 'buy' AND trade_date < ?
      ORDER BY trade_date DESC LIMIT 1
    `).get(code, beforeDate) as { tradeDate: string } | undefined;
    return row?.tradeDate || null;
  }

  // ==================== 成交 ====================

  async createTrade(trade: PaperTrade): Promise<void> {
    this.db.prepare(`
      INSERT INTO paper_trades (order_id, code, side, shares, price, fee, trade_date, executed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.orderId, trade.code, trade.side, trade.shares,
      trade.price, trade.fee, trade.tradeDate, trade.executedAt,
    );
  }

  async getTrades(accountId: string): Promise<PaperTrade[]> {
    return this.db.prepare(`
      SELECT t.order_id as orderId, t.code, t.side, t.shares, t.price, t.fee,
             t.trade_date as tradeDate, t.executed_at as executedAt
      FROM paper_trades t
      JOIN paper_orders o ON t.order_id = o.id
      WHERE o.account_id = ?
      ORDER BY t.trade_date DESC
    `).all(accountId) as PaperTrade[];
  }

  async getTradesByDate(accountId: string, date: string): Promise<PaperTrade[]> {
    return this.db.prepare(`
      SELECT t.order_id as orderId, t.code, t.side, t.shares, t.price, t.fee,
             t.trade_date as tradeDate, t.executed_at as executedAt
      FROM paper_trades t
      JOIN paper_orders o ON t.order_id = o.id
      WHERE o.account_id = ? AND t.trade_date = ?
      ORDER BY t.executed_at ASC
    `).all(accountId, date) as PaperTrade[];
  }

  // ==================== 净值 ====================

  async createNavHistory(nav: PaperNavHistory): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO paper_nav_history (account_id, date, cash, market_value, total, nav)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(nav.accountId, nav.date, nav.cash, nav.marketValue, nav.total, nav.nav);
  }

  async getNavHistory(accountId: string): Promise<PaperNavHistory[]>;
  async getNavHistory(accountId: string, date: string): Promise<PaperNavHistory | null>;
  async getNavHistory(accountId: string, date?: string): Promise<PaperNavHistory[] | PaperNavHistory | null> {
    if (date) {
      const row = this.db.prepare(`
        SELECT account_id as accountId, date, cash, market_value as marketValue, total, nav
        FROM paper_nav_history WHERE account_id = ? AND date = ?
      `).get(accountId, date) as PaperNavHistory | undefined;
      return row || null;
    }
    return this.db.prepare(`
      SELECT account_id as accountId, date, cash, market_value as marketValue, total, nav
      FROM paper_nav_history WHERE account_id = ? ORDER BY date ASC
    `).all(accountId) as PaperNavHistory[];
  }

  async getLatestNav(accountId: string): Promise<PaperNavHistory | null> {
    const row = this.db.prepare(`
      SELECT account_id as accountId, date, cash, market_value as marketValue, total, nav
      FROM paper_nav_history WHERE account_id = ? ORDER BY date DESC LIMIT 1
    `).get(accountId) as PaperNavHistory | undefined;
    return row || null;
  }

  // ==================== 报告 ====================

  async createReport(report: PaperReport): Promise<void> {
    this.db.prepare(`
      INSERT INTO paper_reports (id, date, type, numbers_md, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(report.id, report.date, report.type, report.numbersMd, report.createdAt);
  }

  async getReport(accountId: string, date: string): Promise<PaperReport | null> {
    const row = this.db.prepare(`
      SELECT r.id, r.date, r.type, r.numbers_md as numbersMd, r.created_at as createdAt
      FROM paper_reports r
      WHERE r.date = ?
      ORDER BY r.created_at DESC LIMIT 1
    `).get(date) as PaperReport | undefined;
    return row || null;
  }

  // ==================== 交易日历 ====================

  async isTradingDay(date: string): Promise<boolean> {
    const row = this.db.prepare(`
      SELECT is_trading_day as isTradingDay FROM trading_calendar WHERE date = ?
    `).get(date) as { isTradingDay: number } | undefined;
    return row?.isTradingDay === 1;
  }

  async getTradingDays(startDate: string, endDate: string): Promise<string[]> {
    const rows = this.db.prepare(`
      SELECT date FROM trading_calendar
      WHERE date >= ? AND date <= ? AND is_trading_day = 1
      ORDER BY date ASC
    `).all(startDate, endDate) as { date: string }[];
    return rows.map(r => r.date);
  }

  // ==================== 除权标记 ====================

  async markCorporateAction(code: string, date: string): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO paper_corporate_actions (code, date, detected_at)
      VALUES (?, ?, datetime('now'))
    `).run(code, date);
  }
}
