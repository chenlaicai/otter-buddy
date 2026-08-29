/**
 * 纸面交易 AI 工具
 * 
 * 券商边界原则：
 * - submit_order 是唯一写入口
 * - 其他命令都是只读
 * - AI 无法直接修改账本数值
 */

/* eslint-disable max-lines-per-function, complexity, max-statements -- PR4: paper trade tool needs to handle multiple commands */

import type { AgentTool, ToolContext, ToolResponse } from '@usecases/ports/agent-tools';
import { textResponse, errorResponse } from '@usecases/ports/agent-tools';
import type { Ledger } from '@usecases/paper-trading/ledger';

// 工具命令枚举
const COMMANDS = [
  'submit_order',
  'account',
  'orders',
  'trades',
  'nav',
  'perf',
  'report',
  'is_trading_day',
] as const;

type Command = typeof COMMANDS[number];

export function createPaperTradeTool(_ctx: ToolContext, ledger: Ledger, getAccountId: () => string | undefined): AgentTool {
  return {
    name: 'paper_trade',
    description: `纸面交易工具 - AI 操盘模拟系统

命令列表：
- submit_order: 提交买卖订单（code, side, shares, reason 必填）
- account: 查看账户快照（现金/持仓/净值）
- orders: 查看订单列表
- trades: 查看成交记录
- nav: 查看净值历史
- perf: 查看绩效指标（收益率/最大回撤/夏普比率）
- report: 查看日报/周报（引擎渲染的绩效数字段）
- is_trading_day: 查询交易日历

注意：
- submit_order 是唯一写入口，其他命令只读
- 股票代码格式：6 位数字（如 600519）
- reason 必须 ≥30 字符，需引用数据锚点`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: COMMANDS,
          description: '要执行的命令',
        },
        code: {
          type: 'string',
          description: '股票代码（6 位数字，如 600519）',
        },
        side: {
          type: 'string',
          enum: ['buy', 'sell'],
          description: '买卖方向',
        },
        shares: {
          type: 'number',
          description: '数量（买入必须 100 股整数倍）',
        },
        reason: {
          type: 'string',
          description: '决策理由（≥30 字符，需引用数据锚点）',
        },
        date: {
          type: 'string',
          description: '日期（YYYY-MM-DD，默认今天）',
        },
      },
      required: ['command'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResponse> {
      const command = params.command as Command;
      const accountId = getAccountId();

      if (!accountId && command !== 'is_trading_day') {
        return errorResponse('No paper trading account found');
      }

      try {
        switch (command) {
          case 'submit_order': {
            const code = params.code as string;
            const side = params.side as 'buy' | 'sell';
            const shares = params.shares as number;
            const reason = params.reason as string;
            const order = await ledger.submitOrder(accountId!, code, side, shares, reason);
            return textResponse(JSON.stringify({
              success: true,
              orderId: order.id,
              status: order.status,
            }));
          }

          case 'account': {
            const snapshot = await ledger.getAccountSnapshot(accountId!);
            return textResponse(JSON.stringify(snapshot));
          }

          case 'orders': {
            const orders = await ledger.getOrders(accountId!);
            return textResponse(JSON.stringify(orders));
          }

          case 'trades': {
            const trades = await ledger.getTrades(accountId!);
            return textResponse(JSON.stringify(trades));
          }

          case 'nav': {
            const navHistory = await ledger.getNavHistory(accountId!);
            return textResponse(JSON.stringify(navHistory));
          }

          case 'perf': {
            const performance = await ledger.getPerformance(accountId!);
            return textResponse(JSON.stringify(performance));
          }

          case 'report': {
            const reportDate = (params.date as string) || new Date().toISOString().split('T')[0];
            const report = await ledger.getReport(accountId!, reportDate);
            if (!report) {
              return errorResponse(`No report found for ${reportDate}`);
            }
            return textResponse(JSON.stringify(report));
          }

          case 'is_trading_day': {
            const checkDate = (params.date as string) || new Date().toISOString().split('T')[0];
            const isTrading = await ledger.isTradingDay(checkDate);
            return textResponse(JSON.stringify({ date: checkDate, isTradingDay: isTrading }));
          }

          default:
            return errorResponse(`Unknown command: ${command}`);
        }
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
