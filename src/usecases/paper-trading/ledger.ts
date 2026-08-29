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

/** 撮合结果 */
export interface MatchResult {
  orderId: string;
  status: 'filled' | 'rejected' | 'expired' | 'limit_up' | 'limit_down';
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

  /** 撮合任务（T+1 日 15:05 收盘后执行） */
  async matchOrders(accountId: string, tradeDate: string): Promise<MatchResult[]> {
    // 1. 检查是否交易日
    const isTrading = await this.repo.isTradingDay(tradeDate);
    if (!isTrading) {
      return [];
    }

    // 2. 获取所有 pending 订单
    const pendingOrders = await this.repo.getPendingOrders(accountId);
    if (pendingOrders.length === 0) {
      return [];
    }

    // 3. 获取当日行情（不复权口径）
    const codes = [...new Set(pendingOrders.map(o => o.code))];
    const quotes = await this.getQuotes(codes, tradeDate);

    // 4. 逐单撮合
    const results: MatchResult[] = [];
    for (const order of pendingOrders) {
      const quote = quotes[order.code];
      if (!quote) {
        // 无行情（停牌），保持 pending
        results.push({
          orderId: order.id,
          status: 'rejected',
          rejectReason: 'no_quote',
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

  /** 撮合单个订单 */
  private async matchSingleOrder(
    order: PaperOrder,
    quote: { open: number; prevClose: number },
    tradeDate: string,
  ): Promise<MatchResult> {
    const { open, prevClose } = quote;

    // 涨跌停校验
    const limitCheck = this.checkPriceLimit(order.code, open, prevClose, order.side);
    if (limitCheck !== 'ok') {
      const rejectReason = limitCheck === 'limit_up' ? 'limit_up' : 'limit_down';
      await this.repo.updateOrderStatus(order.id, 'rejected', rejectReason);
      return {
        orderId: order.id,
        status: limitCheck,
        rejectReason,
        trade: null,
      };
    }

    // 计算费用
    const fee = this.calculateFee(order.side, open, order.shares);

    // 创建成交记录
    const trade: PaperTrade = {
      orderId: order.id,
      code: order.code,
      side: order.side,
      shares: order.shares,
      price: open,
      fee,
      tradeDate,
      executedAt: new Date().toISOString(),
    };

    // 更新订单状态
    await this.repo.updateOrderStatus(order.id, 'filled', null);

    // 保存成交记录
    await this.repo.createTrade(trade);

    // 更新持仓
    await this.updatePosition(order.accountId, order.code, order.side, order.shares, open);

    // 更新现金
    await this.updateCash(order.accountId, order.side, open, order.shares, fee);

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

  /** 风控校验 */
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
        const positionValue = position.shares * nav.nav * account.initialCash;
        const totalValue = nav.nav * account.initialCash;
        const positionRatio = (positionValue / totalValue) * 100;
        if (positionRatio >= this.riskRules.maxSinglePosition) {
          throw new Error(`Single position limit reached: ${positionRatio.toFixed(2)}%/${this.riskRules.maxSinglePosition}%`);
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
      const cash = await this.repo.getCash(accountId);
      const amount = shares * 100; // 假设 10 元/股，实际需要取实时价格
      if (cash < amount) {
        throw new Error('Insufficient cash');
      }
    }

    // 卖单持仓校验
    if (side === 'sell') {
      const position = await this.repo.getPosition(accountId, code);
      if (!position || position.shares < shares) {
        throw new Error('Insufficient position');
      }

      // T+1 限制
      const today = this.getToday();
      const lastBuyDate = await this.repo.getLastBuyDate(accountId, code, today);
      if (lastBuyDate && lastBuyDate === today) {
        throw new Error('T+1 restriction: cannot sell on buy day');
      }
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

    // 计算持仓市值（当日收盘价）
    let marketValue = 0;
    for (const position of positions) {
      const closePrice = await this.getClosePrice(position.code, date);
      marketValue += closePrice * position.shares;
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
      const prevClose = await this.getPrevClose(position.code, date);
      const todayOpen = await this.getTodayOpen(position.code, date);

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

    // 保存报告
    const report: PaperReport = {
      id: crypto.randomUUID(),
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
      const currentPrice = await this.getClosePrice(position.code, this.getToday());
      const positionValue = currentPrice * position.shares;
      marketValue += positionValue;

      positionDetails.push({
        code: position.code,
        shares: position.shares,
        avgCost: position.avgCost,
        currentPrice,
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

  /** 获取行情（不复权口径） */
  private async getQuotes(
    codes: string[],
    _date: string,
  ): Promise<Record<string, { open: number; prevClose: number }>> {
    // 通过 stock_data 获取行情
    // 这里需要调用 stock-cli.py 的 kline 命令
    // 暂时返回模拟数据
    const quotes: Record<string, { open: number; prevClose: number }> = {};
    for (const code of codes) {
      quotes[code] = { open: 10, prevClose: 10 };
    }
    return quotes;
  }

  /** 获取收盘价 */
  private async getClosePrice(_code: string, _date: string): Promise<number> {
    // 通过 stock_data 获取收盘价
    // 暂时返回模拟数据
    return 10;
  }

  /** 获取昨收 */
  private async getPrevClose(_code: string, _date: string): Promise<number | null> {
    // 通过 stock_data 获取昨收
    // 暂时返回模拟数据
    return 10;
  }

  /** 获取今日开盘 */
  private async getTodayOpen(_code: string, _date: string): Promise<number | null> {
    // 通过 stock_data 获取今日开盘
    // 暂时返回模拟数据
    return 10;
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
