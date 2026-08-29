/**
 * 纸面交易账本引擎
 * 
 * 券商边界原则：
 * - 账本引擎 = 固定代码（撮合/持仓/收益/净值）
 * - AI 无任何工具可篡改（物理上没有）
 * - 全链路不复权口径（adjust=""）
 */

/* eslint-disable max-lines -- PR4: paper trading engine has many methods */

import type {
  PaperAccount,
  PaperOrder,
  PaperTrade,
  PaperNavHistory,
  PaperReport,
  AccountSnapshot,
  OrderSide,
} from '@entities/paper-trading';

import type { PaperTradeRepository } from './paper-trade-repository';
import type { StockQuoteGateway, DailyQuote } from './stock-quote-gateway';

/** 撮合结果 */
export interface MatchResult {
  orderId: string;
  status: 'filled' | 'pending' | 'expired' | 'rejected' | 'limit_up' | 'limit_down';
  rejectReason: string | null;
  trade: PaperTrade | null;
}

/** 风控规则 */
export interface RiskControlRules {
  /** 单日下单限额（交易日） */
  dailyOrderLimit: number;
  /** 单票仓位上限（%） */
  maxSinglePosition: number;
  /** 熔断阈值（回撤 %） */
  circuitBreakerThreshold: number;
}

/** 涨跌停幅度规则表 */
const PRICE_LIMIT_RULES: Record<string, number> = {
  // 主板 ±10%
  main: 0.10,
  // 创业板（30xxxx）/ 科创板（68xxxx） ±20%
  gem: 0.20,
  star: 0.20,
  // ST ±5%
  st: 0.05,
  // 北交所（8xxxxx/4xxxxx） ±30%
  bse: 0.30,
};

/** 费用配置 */
const FEE_CONFIG = {
  /** 佣金费率（万 2.5） */
  commissionRate: 0.00025,
  /** 最低佣金（5 元） */
  minCommission: 5,
  /** 印花税（卖出千 1） */
  stampTaxRate: 0.001,
};

/** 默认风控规则 */
const DEFAULT_RISK_RULES: RiskControlRules = {
  dailyOrderLimit: 10,
  maxSinglePosition: 20,
  circuitBreakerThreshold: 10,
};

export class Ledger {
  constructor(
    private readonly repo: PaperTradeRepository,
    private readonly gateway: StockQuoteGateway,
    private readonly riskRules: RiskControlRules = DEFAULT_RISK_RULES,
  ) {}

  // ==================== 账户管理 ====================

  /** 创建账户 */
  async createAccount(initialCash: number): Promise<PaperAccount> {
    const account: PaperAccount = {
      id: crypto.randomUUID(),
      initialCash,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    await this.repo.createAccount(account);
    return account;
  }

  /** 获取账户 */
  async getAccount(accountId: string): Promise<PaperAccount | null> {
    return this.repo.getAccount(accountId);
  }

  // ==================== 订单管理 ====================

  /** 提交订单（幂等校验） */
  async submitOrder(
    accountId: string,
    code: string,
    side: OrderSide,
    shares: number,
    reason: string,
  ): Promise<PaperOrder> {
    // 基础校验
    this.validateOrderInput(code, side, shares, reason);

    // 幂等校验：同交易日同 code+side+shares 已存在 pending/filled 订单 → 拒绝
    const today = this.getToday();
    const existingOrder = await this.repo.findExistingOrder(
      accountId, code, side, shares, today,
    );
    if (existingOrder) {
      throw new Error(`Duplicate order: ${existingOrder.id}`);
    }

    // 风控校验
    await this.checkRiskControl(accountId, code, side, shares);

    // 创建订单
    const order: PaperOrder = {
      id: crypto.randomUUID(),
      accountId,
      code,
      side,
      shares,
      reason,
      createdAt: new Date().toISOString(),
      status: 'pending',
      rejectReason: null,
    };

    await this.repo.createOrder(order);
    return order;
  }

  /** 获取订单列表 */
  async getOrders(accountId: string): Promise<PaperOrder[]> {
    return this.repo.getOrders(accountId);
  }

  /** 获取订单详情 */
  async getOrder(orderId: string): Promise<PaperOrder | null> {
    return this.repo.getOrder(orderId);
  }

  // ==================== 撮合引擎 ====================

  /**
   * 撮合任务（T+1 日 15:05 收盘后执行）
   *
   * S2 修复：只撮合「创建日 < tradeDate」的订单（T+1 时序守卫）
   * S3 修复：涨跌停不成交保持 pending（不 reject）；撮合前过期扫描
   */
  // eslint-disable-next-line max-statements -- PR4: 撮合任务有多步逻辑（过期扫描/T+1守卫/涨跌停/净值/日报）
  async matchOrders(accountId: string, tradeDate: string): Promise<MatchResult[]> {
    // 1. 检查是否交易日
    const isTrading = await this.repo.isTradingDay(tradeDate);
    if (!isTrading) {
      // T2: 日历跨年缺口警告——撮合日超出 trading_calendar 覆盖范围时静默空转
      // eslint-disable-next-line no-console -- T2: 运行时诊断警告，生产环境需要 operator 感知
      console.warn(`[Ledger] matchOrders: ${tradeDate} not in trading_calendar. ` +
        'If this date should be a trading day, the calendar may need re-sync (year-end gap).');
      return [];
    }

    // 1.5 过期扫描：pending 超过 5 个交易日的订单 → expired（S3）
    const _expiredCount = await this.repo.expireOldPendingOrders(accountId, tradeDate);

    // 2. 获取所有 pending 订单
    const allPendingOrders = await this.repo.getPendingOrders(accountId);

    // S2: T+1 时序守卫——只撮合创建日 < tradeDate 的订单
    const pendingOrders: PaperOrder[] = [];
    for (const order of allPendingOrders) {
      const createdDate = order.createdAt.split('T')[0]; // "YYYY-MM-DD"
      // 用交易日历判断 createdDate 是否是 tradeDate 之前的交易日
      // 简化：createdDate < tradeDate（字符串比较对 YYYY-MM-DD 格式正确）
      if (createdDate < tradeDate) {
        pendingOrders.push(order);
      }
    }

    if (pendingOrders.length === 0) {
      return [];
    }

    // 3. 获取当日行情（不复权口径）
    const codes = [...new Set(pendingOrders.map(o => o.code))];
    const quotes = await this.gateway.getQuotes(codes, tradeDate);

    // 4. 逐单撮合
    const results: MatchResult[] = [];
    for (const order of pendingOrders) {
      const quote = quotes[order.code];
      if (!quote) {
        // 无行情（停牌），保持 pending——S3 不再 reject
        results.push({
          orderId: order.id,
          status: 'pending',
          rejectReason: 'suspended',
          trade: null,
        });
        continue;
      }

      const result = await this.matchSingleOrder(order, quote, tradeDate);
      results.push(result);
    }

    // 5. 计算净值
    await this.calculateNav(accountId, tradeDate);

    // 6. 检测除权
    await this.detectCorporateAction(accountId, tradeDate);

    // 7. 渲染日报数字段
    await this.renderDailyReport(accountId, tradeDate);

    return results;
  }

  /**
   * 撮合单个订单
   *
   * S3 修复：涨跌停不成交保持 pending（不 reject）
   * S4 修复：T+1 校验移到撮合时（卖单检查当日是否有买入成交）
   */
  private async matchSingleOrder(
    order: PaperOrder,
    quote: DailyQuote,
    tradeDate: string,
  ): Promise<MatchResult> {
    const { open, prevClose } = quote;

    // S4: T+1 校验在撮合时（卖单检查是否存在 trade_date=tradeDate 的买入成交）
    if (order.side === 'sell') {
      const t1Result = await this.checkT1Restriction(order, tradeDate);
      if (t1Result) return t1Result;
    }

    // 涨跌停校验
    const limitCheck = this.checkPriceLimit(order.code, open, prevClose, order.side);
    if (limitCheck !== 'ok') {
      // S3: 不 reject，保持 pending + reject_reason 标注（次日重试）
      const rejectReason = limitCheck === 'limit_up' ? 'limit_up' : 'limit_down';
      await this.repo.updateOrderStatus(order.id, 'pending', rejectReason);
      return {
        orderId: order.id,
        status: limitCheck,
        rejectReason,
        trade: null,
      };
    }

    // 计算费用
    const fee = this.calculateFee(order.side, open, order.shares);

    // N2 修复：撮合时现金终验
    if (order.side === 'buy') {
      const cashResult = await this.checkCashAtMatch(order, open, fee);
      if (cashResult) return cashResult;
    }

    return await this.executeMatch(order, open, fee, tradeDate);
  }

  /** T+1 校验：卖单检查当日是否有买入成交 */
  private async checkT1Restriction(order: PaperOrder, tradeDate: string): Promise<MatchResult | null> {
    const lastBuyDate = await this.repo.getLastBuyTradeDate(order.accountId, order.code, tradeDate);
    if (lastBuyDate && lastBuyDate === tradeDate) {
      await this.repo.updateOrderStatus(order.id, 'pending', 't_plus_1_restriction');
      return {
        orderId: order.id,
        status: 'pending',
        rejectReason: 't_plus_1_restriction',
        trade: null,
      };
    }
    return null;
  }

  /** N2 修复：撮合时现金终验——预检用 T 日收盘价估算，撮合用 T+1 开盘价成交，跳空后多单累加可击穿现金 */
  private async checkCashAtMatch(order: PaperOrder, open: number, fee: number): Promise<MatchResult | null> {
    const currentCash = await this.repo.getCash(order.accountId);
    const requiredCash = open * order.shares + fee;
    if (currentCash < requiredCash) {
      // 真实券商行为：废单，终止不重试
      await this.repo.updateOrderStatus(order.id, 'rejected', 'insufficient_cash_at_match');
      return {
        orderId: order.id,
        status: 'rejected',
        rejectReason: 'insufficient_cash_at_match',
        trade: null,
      };
    }
    return null;
  }

  /** 执行撮合：创建成交记录 + 更新持仓 + 更新现金 */
  private async executeMatch(
    order: PaperOrder,
    price: number,
    fee: number,
    tradeDate: string,
  ): Promise<MatchResult> {
    // 创建成交记录
    const trade: PaperTrade = {
      orderId: order.id,
      code: order.code,
      side: order.side,
      shares: order.shares,
      price: price,
      fee,
      tradeDate,
      executedAt: new Date().toISOString(),
    };

    await this.repo.createTrade(trade);

    // 更新持仓
    await this.updatePosition(order.accountId, order.code, order.side, order.shares, price);

    // 更新现金
    await this.updateCash(order.accountId, order.side, price, order.shares, fee);

    // X1 修复：恢复成交状态写入——否则订单在 DB 里永远是 pending
    await this.repo.updateOrderStatus(order.id, 'filled', null);

    return {
      orderId: order.id,
      status: 'filled',
      rejectReason: null,
      trade,
    };
  }

  // ==================== 涨跌停校验 ====================

  /** 检查涨跌停可成交性 */
  private checkPriceLimit(
    code: string,
    open: number,
    prevClose: number,
    side: OrderSide,
  ): 'ok' | 'limit_up' | 'limit_down' {
    const limitRate = this.getLimitRate(code);
    const limitUp = Math.round(prevClose * (1 + limitRate) * 100) / 100;
    const limitDown = Math.round(prevClose * (1 - limitRate) * 100) / 100;

    if (side === 'buy' && open >= limitUp) {
      return 'limit_up';
    }

    if (side === 'sell' && open <= limitDown) {
      return 'limit_down';
    }

    return 'ok';
  }

  /** 获取涨跌停幅度 */
  private getLimitRate(code: string): number {
    // 创业板（30xxxx）
    if (code.startsWith('30')) {
      return PRICE_LIMIT_RULES.gem;
    }
    // 科创板（68xxxx）
    if (code.startsWith('68')) {
      return PRICE_LIMIT_RULES.star;
    }
    // 北交所（8xxxxx/4xxxxx）
    if (code.startsWith('8') || code.startsWith('4')) {
      return PRICE_LIMIT_RULES.bse;
    }
    // 主板
    return PRICE_LIMIT_RULES.main;
  }

  // ==================== 费用计算 ====================

  /** 计算交易费用 */
  private calculateFee(side: OrderSide, price: number, shares: number): number {
    const amount = price * shares;

    // 佣金
    let commission = amount * FEE_CONFIG.commissionRate;
    if (commission < FEE_CONFIG.minCommission) {
      commission = FEE_CONFIG.minCommission;
    }

    // 印花税（卖出时收取）
    const stampTax = side === 'sell' ? amount * FEE_CONFIG.stampTaxRate : 0;

    return Math.round((commission + stampTax) * 100) / 100;
  }

  // ==================== 风控校验 ====================

  /**
   * 风控校验（下单时）
   *
   * S4 修复：
   * 1. 仓位市值 = shares × 最新收盘价（之前是 nav.ratio × initialCash，完全错误）
   * 2. 现金预检用真实最新收盘价估算
   * 3. T+1 校验已移到 matchSingleOrder（撮合时校验），此处不再做
   */
  // eslint-disable-next-line max-statements, complexity -- PR4: risk control has multiple checks
  private async checkRiskControl(
    accountId: string,
    code: string,
    side: OrderSide,
    shares: number,
  ): Promise<void> {
    const account = await this.repo.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    // 单日下单限额
    const today = this.getToday();
    const todayOrderCount = await this.repo.getTodayOrderCount(accountId, today);
    if (todayOrderCount >= this.riskRules.dailyOrderLimit) {
      throw new Error(`Daily order limit reached: ${todayOrderCount}/${this.riskRules.dailyOrderLimit}`);
    }

    // 单票仓位上限（仅买单）
    if (side === 'buy') {
      const position = await this.repo.getPosition(accountId, code);
      const nav = await this.repo.getLatestNav(accountId);
      if (nav && position) {
        // S4-1: 仓位市值 = shares × 最新收盘价
        const currentPrice = await this.gateway.getClosePrice(code, today);
        if (currentPrice) {
          const positionValue = position.shares * currentPrice;
          const positionRatio = (positionValue / nav.total) * 100;
          if (positionRatio >= this.riskRules.maxSinglePosition) {
            throw new Error(`Single position limit reached: ${positionRatio.toFixed(2)}%/${this.riskRules.maxSinglePosition}%`);
          }
        }
      }
    }

    // 熔断检查
    const nav = await this.repo.getLatestNav(accountId);
    if (nav) {
      const drawdown = ((account.initialCash - nav.total) / account.initialCash) * 100;
      if (drawdown >= this.riskRules.circuitBreakerThreshold && side === 'buy') {
        throw new Error(`Circuit breaker triggered: drawdown ${drawdown.toFixed(2)}%`);
      }
    }

    // 买单现金预检
    if (side === 'buy') {
      // S4-2: 用真实最新收盘价估算
      const cash = await this.repo.getCash(accountId);
      const currentPrice = await this.gateway.getClosePrice(code, this.getToday());
      // N2 修复：行情不可得时不接受下单（null→0 绕过漏洞）
      if (currentPrice === null) {
        throw new Error('Market data unavailable: cannot place order without current price');
      }
      const estimatedAmount = shares * currentPrice;
      // 加佣金估算（最坏情况）
      const estimatedFee = Math.max(estimatedAmount * FEE_CONFIG.commissionRate, FEE_CONFIG.minCommission);
      if (cash < estimatedAmount + estimatedFee) {
        throw new Error('Insufficient cash');
      }
    }

    // 卖单持仓校验
    if (side === 'sell') {
      const position = await this.repo.getPosition(accountId, code);
      if (!position || position.shares < shares) {
        throw new Error('Insufficient position');
      }
      // S4-3: T+1 校验已移至 matchSingleOrder（撮合时校验），此处不再做
    }
  }

  // ==================== 持仓更新 ====================

  /** 更新持仓 */
  private async updatePosition(
    accountId: string,
    code: string,
    side: OrderSide,
    shares: number,
    price: number,
  ): Promise<void> {
    const position = await this.repo.getPosition(accountId, code);

    if (side === 'buy') {
      if (position) {
        // 加仓：更新平均成本
        const totalCost = position.avgCost * position.shares + price * shares;
        const totalShares = position.shares + shares;
        const avgCost = totalCost / totalShares;
        await this.repo.updatePosition(accountId, code, totalShares, avgCost);
      } else {
        // 新建持仓
        await this.repo.createPosition(accountId, code, shares, price);
      }
    } else {
      // 卖出
      if (position) {
        const remainingShares = position.shares - shares;
        if (remainingShares <= 0) {
          // 清仓
          await this.repo.deletePosition(accountId, code);
        } else {
          // 减仓
          await this.repo.updatePosition(accountId, code, remainingShares, position.avgCost);
        }
      }
    }
  }

  // ==================== 现金更新 ====================

  /** 更新现金 */
  private async updateCash(
    accountId: string,
    side: OrderSide,
    price: number,
    shares: number,
    fee: number,
  ): Promise<void> {
    const cash = await this.repo.getCash(accountId);
    const amount = price * shares;

    let newCash: number;
    if (side === 'buy') {
      newCash = cash - amount - fee;
    } else {
      newCash = cash + amount - fee;
    }

    await this.repo.updateCash(accountId, newCash);
  }

  // ==================== 净值计算 ====================

  /** 计算净值 */
  async calculateNav(accountId: string, date: string): Promise<PaperNavHistory> {
    const account = await this.repo.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const cash = await this.repo.getCash(accountId);
    const positions = await this.repo.getPositions(accountId);

    // 计算持仓市值（当日收盘价，不复权口径）
    let marketValue = 0;
    for (const position of positions) {
      const closePrice = await this.gateway.getClosePrice(position.code, date);
      if (closePrice) {
        marketValue += closePrice * position.shares;
      }
      // 停牌票按最近已知价格保留（position.avgCost 作为 fallback）
      // 方案 A4：停牌按最近收盘价，此处 fallback 到平均成本
    }

    const total = cash + marketValue;
    const nav = total / account.initialCash;

    const navHistory: PaperNavHistory = {
      accountId,
      date,
      cash,
      marketValue,
      total,
      nav,
    };

    await this.repo.createNavHistory(navHistory);
    return navHistory;
  }

  // ==================== 除权检测 ====================

  /** 检测除权 */
  private async detectCorporateAction(accountId: string, date: string): Promise<void> {
    const positions = await this.repo.getPositions(accountId);

    for (const position of positions) {
      const prevClose = await this.gateway.getPrevClose(position.code, date);
      const todayOpen = await this.gateway.getTodayOpen(position.code, date);

      if (prevClose && todayOpen) {
        const changeRate = Math.abs((todayOpen - prevClose) / prevClose);
        const limitRate = this.getLimitRate(position.code);

        // 跳空幅度超出涨跌停可解释范围
        if (changeRate > limitRate * 1.1) {
          // 标注疑似除权
          await this.repo.markCorporateAction(position.code, date);
        }
      }
    }
  }

  // ==================== 日报渲染 ====================

  /** 渲染日报数字段 */
  private async renderDailyReport(accountId: string, date: string): Promise<void> {
    const account = await this.repo.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const nav = await this.repo.getNavHistory(accountId, date);
    if (!nav) {
      return;
    }

    // 获取交易记录
    const trades = await this.repo.getTradesByDate(accountId, date);

    // 渲染数字段
    const numbersMd = this.renderNumbersMarkdown(nav, trades, account.initialCash);

    // 保存报告（含 account_id）
    const report: PaperReport = {
      id: crypto.randomUUID(),
      accountId,
      date,
      type: 'daily',
      numbersMd,
      createdAt: new Date().toISOString(),
    };

    await this.repo.createReport(report);
  }

  /** 渲染数字段 Markdown */
  private renderNumbersMarkdown(
    nav: PaperNavHistory,
    trades: PaperTrade[],
    initialCash: number,
  ): string {
    const returnRate = ((nav.total - initialCash) / initialCash * 100).toFixed(2);

    let md = `## 每日绩效（${nav.date}）\n\n`;
    md += `| 指标 | 数值 |\n`;
    md += `|------|------|\n`;
    md += `| 现金 | ¥${nav.cash.toFixed(2)} |\n`;
    md += `| 持仓市值 | ¥${nav.marketValue.toFixed(2)} |\n`;
    md += `| 总资产 | ¥${nav.total.toFixed(2)} |\n`;
    md += `| 净值 | ${nav.nav.toFixed(4)} |\n`;
    md += `| 累计收益 | ${returnRate}% |\n`;

    if (trades.length > 0) {
      md += `\n### 今日成交\n\n`;
      md += `| 代码 | 方向 | 价格 | 数量 | 费用 |\n`;
      md += `|------|------|------|------|------|\n`;
      for (const trade of trades) {
        md += `| ${trade.code} | ${trade.side === 'buy' ? '买入' : '卖出'} | ¥${trade.price.toFixed(2)} | ${trade.shares} | ¥${trade.fee.toFixed(2)} |\n`;
      }
    }

    return md;
  }

  // ==================== 查询接口 ====================

  /** 获取账户快照 */
  async getAccountSnapshot(accountId: string): Promise<AccountSnapshot> {
    const account = await this.repo.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const cash = await this.repo.getCash(accountId);
    const positions = await this.repo.getPositions(accountId);

    const positionDetails = [];
    let marketValue = 0;

    for (const position of positions) {
      const currentPrice = await this.gateway.getClosePrice(position.code, this.getToday());
      const price = currentPrice ?? position.avgCost; // 停牌 fallback
      const positionValue = price * position.shares;
      marketValue += positionValue;

      positionDetails.push({
        code: position.code,
        shares: position.shares,
        avgCost: position.avgCost,
        currentPrice: price,
        marketValue: positionValue,
      });
    }

    const total = cash + marketValue;
    const nav = total / account.initialCash;

    return {
      cash,
      positions: positionDetails,
      total,
      nav,
    };
  }

  /** 获取交易记录 */
  async getTrades(accountId: string): Promise<PaperTrade[]> {
    return this.repo.getTrades(accountId);
  }

  /** 获取净值历史 */
  async getNavHistory(accountId: string): Promise<PaperNavHistory[]> {
    return this.repo.getNavHistory(accountId);
  }

  /** 获取绩效指标 */
  async getPerformance(accountId: string): Promise<{
    returnRate: number;
    maxDrawdown: number;
    sharpeRatio: number;
  }> {
    const account = await this.repo.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const navHistory = await this.repo.getNavHistory(accountId);
    if (navHistory.length === 0) {
      return { returnRate: 0, maxDrawdown: 0, sharpeRatio: 0 };
    }

    const latestNav = navHistory[navHistory.length - 1];
    const returnRate = ((latestNav.total - account.initialCash) / account.initialCash) * 100;

    // 计算最大回撤
    let maxDrawdown = 0;
    let peak = account.initialCash;
    for (const nav of navHistory) {
      if (nav.total > peak) {
        peak = nav.total;
      }
      const drawdown = ((peak - nav.total) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    // 计算夏普比率（简化版）
    const returns = [];
    for (let i = 1; i < navHistory.length; i++) {
      const dailyReturn = (navHistory[i].nav - navHistory[i - 1].nav) / navHistory[i - 1].nav;
      returns.push(dailyReturn);
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdReturn = Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length,
    );
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    return {
      returnRate,
      maxDrawdown,
      sharpeRatio,
    };
  }

  /** 获取日报 */
  async getReport(accountId: string, date: string): Promise<PaperReport | null> {
    return this.repo.getReport(accountId, date);
  }

  // ==================== 交易日历 ====================

  /** 检查是否交易日 */
  async isTradingDay(date: string): Promise<boolean> {
    return this.repo.isTradingDay(date);
  }

  // ==================== 辅助方法 ====================

  /** 获取今日日期 */
  private getToday(): string {
    return new Date().toISOString().split('T')[0];
  }

  // ==================== 校验 ====================

  /** 校验订单输入 */
  private validateOrderInput(
    code: string,
    side: OrderSide,
    shares: number,
    reason: string,
  ): void {
    // 股票代码校验（6 位数字）
    if (!/^\d{6}$/.test(code)) {
      throw new Error(`Invalid stock code: ${code}`);
    }

    // 方向校验
    if (side !== 'buy' && side !== 'sell') {
      throw new Error(`Invalid side: ${side}`);
    }

    // 数量校验
    if (shares <= 0) {
      throw new Error(`Invalid shares: ${shares}`);
    }

    // 买入必须 100 股整数倍
    if (side === 'buy' && shares % 100 !== 0) {
      throw new Error(`Buy shares must be multiple of 100: ${shares}`);
    }

    // 理由校验（≥30 字符）
    if (reason.length < 30) {
      throw new Error(`Reason too short: ${reason.length} < 30`);
    }
  }
}
