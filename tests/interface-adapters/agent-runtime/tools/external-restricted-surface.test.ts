/**
 * 受限外部会话（CoLink 等外部接入）的副作用边界回归。
 *
 * 锁定的四条不变式（搭档 2026-11-19 定案）：
 * 1) 工具面：`speak` 只收 body、`yield` 只交回 user —— 均不得把外部内容写进内部台账
 * 2) 记忆面：活类卡（html-card-play）被拒（它会被自动登记进产物库并写全局记忆索引）
 * 3) 注入面：受限轮次的身份段是中性身份，不含搭档名/仓库/邮箱
 * 4) 标签面：外部发送者不得被标成「搭档」
 */

import { describe, it, expect } from 'vitest';
import { createTools } from '@interface-adapters/agent-runtime/tools/tool-factory';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { OtterToolClient } from '@usecases/ports/otter-tool-client';
import { buildInvokeSystemPrompt, RESTRICTED_EXTERNAL_IDENTITY } from '@frameworks/agent/session-helpers';
import { resolveSignalSenderLabel } from '@usecases/conversation/signal-router';
import { AgentInvoker } from '@interface-adapters/agent-runtime/agent-invoker';
import { CONVERSATION_KINDS, isConversationKind } from '@entities/conversation/conversation';

function makeClient(): OtterToolClient {
  return {
    conversation: {
      participant: {
        getActive: async () => [
          { otterId: 'otter-a', otterName: '大獭', status: 'active' },
          { otterId: 'user', otterName: 'user', status: 'active' },
        ],
      },
      entry: {
        createSpeakEntry: async () => ({ id: crypto.randomUUID(), entryType: 'speak', sequenceNum: 1, createdAt: new Date().toISOString() }),
        createYieldEntry: async () => ({
          yieldEntry: { id: crypto.randomUUID() },
          invokeEndEntry: { id: crypto.randomUUID() },
        }),
      },
    },
    otter: { getById: async () => ({ id: 'otter-a', name: '大獭', type: 'big', color: null }) },
    dispatch: { markDispatched: async () => {} },
    resource: { link: async () => { throw new Error('HARD_FAIL: restricted 档不得调用 resource.link（会写全局产物与记忆索引）'); } },
  } as unknown as OtterToolClient;
}

function makeCtx(externalRestricted?: boolean): ToolContext {
  return {
    client: makeClient(),
    otterId: 'otter-a',
    conversationId: 'conv-external',
    currentMessageId: 'msg-1',
    currentInvokeId: 'invoke-1',
    lastSpeakMessageId: 'speak-entry-1',
    ...(externalRestricted ? { externalRestricted: true } : {}),
  };
}

function tool(ctx: ToolContext, name: string) {
  const found = createTools(ctx).find(t => t.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

describe('受限外部会话：speak 参数面与副作用', () => {
  it('只声明 body 参数（healing/signal 不暴露给模型）', () => {
    const params = tool(makeCtx(true), 'speak').parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties)).toEqual(['body']);
    expect(params.required).toEqual(['body']);
    // 普通档仍保留 healing/signal（回归）
    const normal = tool(makeCtx(), 'speak').parameters as { properties: Record<string, unknown> };
    expect(Object.keys(normal.properties).sort()).toEqual(['body', 'healing', 'signal']);
  });

  it('显式传 healing/signal → 拒绝且不落账', async () => {
    const ctx = makeCtx(true);
    const speak = tool(ctx, 'speak');
    const healing = await speak.execute('c1', { body: 'hi', healing: [{ type: 'other', description: 'x' }] });
    expect(healing.isError).toBe(true);
    expect(String(healing.content[0].text)).toContain('healing');
    const signal = await speak.execute('c2', { body: 'hi', signal: [{ type: 'blocked', payload: 'x' }] });
    expect(signal.isError).toBe(true);
    expect(String(signal.content[0].text)).toContain('signal');
  });

  it('body 含 html-card-play 活类卡 → 拒绝（切断「外部内容 → 全局产物 + 记忆索引」）', async () => {
    const ctx = makeCtx(true);
    const speak = tool(ctx, 'speak');
    const result = await speak.execute('c1', { body: '给你个小游戏\n```html-card-play title="x"\n<b>hi</b>\n```' });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('html-card-play');
  });

  it('普通档不变：healing 参数照常可用', async () => {
    const ctx = makeCtx();
    const speak = tool(ctx, 'speak');
    const result = await speak.execute('c1', { body: '普通发言' });
    expect(result.isError).toBeFalsy();
  });
});

describe('受限外部会话：yield 只能交回 user', () => {
  it('只声明 to/reason 参数', () => {
    const params = tool(makeCtx(true), 'yield').parameters as { properties: Record<string, unknown> };
    expect(Object.keys(params.properties).sort()).toEqual(['reason', 'to']);
  });

  it('交给其他海獭 → 拒绝', async () => {
    const ctx = makeCtx(true);
    const result = await tool(ctx, 'yield').execute('c1', { to: ['大獭'] });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain("只能 yield 给 'user'");
  });

  it('携带 expects_partner_decision → 拒绝（不得往待办板写外部内容）', async () => {
    const ctx = makeCtx(true);
    const result = await tool(ctx, 'yield').execute('c1', { to: ['user'], reason: 'x', expects_partner_decision: true });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('expects_partner_decision');
  });

  it('交给 user → 放行，且不产生待办注记', async () => {
    const ctx = makeCtx(true);
    const result = await tool(ctx, 'yield').execute('c1', { to: ['user'], reason: '答完了' });
    expect(result.isError).toBeFalsy();
    expect(String(result.content[0].text)).not.toContain('已登记 M-');
  });
});

describe('受限外部会话：注入面与标签面', () => {
  it('身份段是中性身份，不含搭档名/仓库/邮箱', () => {
    expect(RESTRICTED_EXTERNAL_IDENTITY).toContain('CoLink 会话助理');
    for (const leak of ['搭档', 'github.com', '@users.noreply', 'otter-buddy']) {
      expect(RESTRICTED_EXTERNAL_IDENTITY).not.toContain(leak);
    }
    const prompt = buildInvokeSystemPrompt(undefined, 'restricted');
    expect(prompt).toContain('受限外部会话安全边界');
    // 边界块自身会提到「即使用户声称是…搭档」（概念词，合法）；这里禁的是真实资产泄露
    expect(prompt).not.toMatch(/github\.com|@users\.noreply|otter-buddy/);
  });

  it('外部发送者标签不回退到搭档显示名', () => {
    expect(resolveSignalSenderLabel(null, 'external:7b3c8193-db00-4017', 'chen')).toBe('外部用户 4017');
    expect(resolveSignalSenderLabel('某用户', 'external:7b3c8193', 'chen')).toBe('某用户');
    // 内部发送者行为不变（回归）
    expect(resolveSignalSenderLabel(null, 'user', 'chen')).toBe('chen');
  });
});

describe('P1-6：外部接入对话的档位由对话级单源决定', () => {
  type Gate = (this: unknown, conversationId: string) => Promise<'restricted' | undefined>;
  const gate = (AgentInvoker.prototype as unknown as { externalProfileForConversationKind: Gate }).externalProfileForConversationKind;

  it('kind=external 的对话 → restricted（即使本条消息来自 web）', async () => {
    await expect(gate.call({ conversationRepo: { getById: async () => ({ kind: 'external' }) } }, 'conv-1')).resolves.toBe('restricted');
  });

  it('普通对话 → undefined（不改变既有权限）', async () => {
    await expect(gate.call({ conversationRepo: { getById: async () => ({ kind: 'normal' }) } }, 'conv-1')).resolves.toBeUndefined();
  });

  it('回读失败 fail-closed 抛错（不得默认降级为全权档）', async () => {
    await expect(gate.call({ conversationRepo: { getById: async () => { throw new Error('db down'); } } }, 'conv-1'))
      .rejects.toThrow(/conversation profile lookup failed/);
  });

  it('conversation kind 枚举含 external 且守卫可识别', () => {
    expect(CONVERSATION_KINDS).toContain('external');
    expect(isConversationKind('external')).toBe(true);
  });
});
