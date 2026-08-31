/**
 * 注册纸面交易函数到函数注册表
 * 
 * PR4: 撮合任务使用 function executor，不创建 agent 会话
 */

import { paperTradingFunctionRegistry } from './function-registry';
import type { Ledger } from './ledger';
import type { PaperTradeRepository } from './paper-trade-repository';

/** 获取 Asia/Shanghai 今日日期（YYYY-MM-DD） */
function getTodayShanghai(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** 注册纸面交易函数 */
export function registerPaperTradingFunctions(ledger: Ledger, repo?: PaperTradeRepository): void {
  // 注册撮合函数
  paperTradingFunctionRegistry.register('match_orders', async (params) => {
    const raw = params as { accountId?: string; tradeDate?: string };

    // F20260829ppta 发现 2 修复：accountId 缺省时取首个 active 账户（与工具链同口径）
    let accountId = raw.accountId;
    if (!accountId) {
      if (!repo) throw new Error('match_orders: accountId not provided and repo not available for fallback');
      accountId = (await repo.getFirstActiveAccountId()) ?? undefined;
      if (!accountId) throw new Error('match_orders: no active paper account found. Create an account first.');
    }

    // F20260829ppta 发现 2 修复：tradeDate 缺省取今日 Asia/Shanghai（禁 toISOString，N1 教训）
    const tradeDate = raw.tradeDate ?? getTodayShanghai();

    const results = await ledger.matchOrders(accountId, tradeDate);
    
    return {
      success: true,
      accountId,
      tradeDate,
      matchedOrders: results.length,
      results,
    };
  });

  // 注册净值计算函数
  paperTradingFunctionRegistry.register('calculate_nav', async (params) => {
    const { accountId, date } = params as { accountId: string; date: string };
    
    const navHistory = await ledger.calculateNav(accountId, date);
    
    return {
      success: true,
      accountId,
      date,
      nav: navHistory.nav,
      total: navHistory.total,
      cash: navHistory.cash,
      marketValue: navHistory.marketValue,
    };
  });

  // 注册日报渲染函数
  paperTradingFunctionRegistry.register('render_daily_report', async (params) => {
    const { accountId, date } = params as { accountId: string; date: string };
    
    // 渲染日报绩效数字段
    const performance = await ledger.getPerformance(accountId);
    const navHistory = await ledger.getNavHistory(accountId);
    
    return {
      success: true,
      accountId,
      date,
      performance,
      navHistory,
    };
  });
}
