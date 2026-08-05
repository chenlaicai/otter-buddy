import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProcessInboundRecruit } from '@usecases/recruiting/process-inbound-recruit';
import type { MessageMetadata } from '@entities/conversation/message';
import type { Logger } from '@usecases/ports/logger';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { QueryMessage } from '@usecases/conversation/query-message';
import type { DispatchChainEngine } from '@usecases/conversation/dispatch-chain-engine';
import type { AgentInvokePort } from '@usecases/scheduler/agent-invoke-port';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { Message } from '@entities/conversation/message';

const CONV_ID = 'conv-recruiting';
const BIG_OTTER_ID = 'otter-big';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger;
}

interface MockState {
  sentMessages: Array<{ conversationId: string; body: string; metadata: MessageMetadata | null; talkingStonePassedTo: string[]; senderType: string }>;
  executeChainCalls: Array<{ initialTargets: string[]; conversationId: string }>;
  findByExternalIdCalls: string[];
}

type ProcessInboundRecruitCtorArgs = ConstructorParameters<typeof ProcessInboundRecruit>;

function makeMocks(): { mocks: MockState; depSet: ProcessInboundRecruitCtorArgs; instances: any } {
  const state: MockState = {
    sentMessages: [],
    executeChainCalls: [],
    findByExternalIdCalls: [],
  };

  const settingsGet = vi.fn(async (key: string) => {
    if (key === '__recruiting_conversation_id__') return CONV_ID;
    if (key === '__recruiting_big_otter_id__') return BIG_OTTER_ID;
    return null;
  });
  const settingsRepo = {
    get: settingsGet,
    update: vi.fn(async () => {}),
  } as unknown as SettingsRepository;

  const queryMessage = {
    findByExternalId: vi.fn(async (id: string) => {
      state.findByExternalIdCalls.push(id);
      return null;
    }),
  } as unknown as QueryMessage;

  const sendMessage = {
    send: vi.fn(async (input) => {
      state.sentMessages.push({
        conversationId: input.conversationId,
        body: input.body,
        metadata: input.metadata ?? null,
        talkingStonePassedTo: input.talkingStonePassedTo,
        senderType: input.senderType,
      });
      return {
        id: 'msg-' + Math.random().toString(36).slice(2),
        conversationId: input.conversationId,
        body: input.body,
        metadata: input.metadata ?? null,
      } as Message;
    }),
    sendSystem: vi.fn(),
  } as unknown as SendMessage;

  const dispatchChainEngine = {
    executeChain: vi.fn(async (params) => {
      state.executeChainCalls.push({
        initialTargets: params.initialTargets,
        conversationId: params.conversationId,
      });
      return { otterReply: undefined };
    }),
  } as unknown as DispatchChainEngine;

  const agentInvokePort: AgentInvokePort = {
    invokeConversation: vi.fn(async () => ({ messageId: 'm1' })),
  };

  return {
    mocks: state,
    depSet: [settingsRepo, queryMessage, sendMessage, dispatchChainEngine, agentInvokePort, makeLogger()] as ProcessInboundRecruitCtorArgs,
    instances: { settingsRepo, queryMessage, sendMessage, dispatchChainEngine, agentInvokePort },
  };
}

async function flushAsync() {
  // fire-and-forget triggerDispatch 让 microtask 跑完
  await new Promise(r => setTimeout(r, 10));
}

describe('ProcessInboundRecruit', () => {
  let state: MockState;
  let usecase: ProcessInboundRecruit;
  let instances: any;

  beforeEach(() => {
    const setup = makeMocks();
    state = setup.mocks;
    instances = setup.instances;
    usecase = new ProcessInboundRecruit(...setup.depSet);
  });

  describe('recruit kind', () => {
    it('空数组直接返回 accepted=0 不写入', async () => {
      const result = await usecase.execute({ kind: 'recruit', messages: [] });
      expect(result.accepted).toBe(0);
      expect(result.deduplicated).toBe(0);
      expect(state.sentMessages.length).toBe(0);
    });

    it('全部新消息：组装成一条系统消息 + 一次 invoke', async () => {
      const messages = [
        { externalId: 'boss:b1:m1', bossId: 'b1', hrName: '王', company: '字节', position: '前端', content: '你好', time: 1700000000000 },
        { externalId: 'boss:b2:m2', bossId: 'b2', hrName: '李', company: '美团', position: 'PM', content: '要简历', time: 1700000001000 },
      ];

      const result = await usecase.execute({ kind: 'recruit', messages });

      expect(result.accepted).toBe(2);
      expect(result.deduplicated).toBe(0);
      expect(state.sentMessages.length).toBe(1);
      const sent = state.sentMessages[0];
      expect(sent.body).toContain('[招聘消息批次·BOSS直聘');
      expect(sent.body).toContain('共 2 条新消息');
      expect(sent.body).toContain('字节');
      expect(sent.body).toContain('美团');
      expect(sent.metadata?.externalId).toBe('boss:b1:m1|boss:b2:m2');
      expect(sent.talkingStonePassedTo).toEqual([BIG_OTTER_ID]);
      expect(sent.senderType).toBe('system');
      await flushAsync();
      expect(state.executeChainCalls.length).toBe(1);
      expect(state.executeChainCalls[0].initialTargets).toEqual([BIG_OTTER_ID]);
    });

    it('externalId 查重：已存在的消息被跳过', async () => {
      instances.queryMessage.findByExternalId = vi.fn(async (id: string) =>
        id === 'boss:b1:m1' ? ({} as Message) : null,
      );
      const messages = [
        { externalId: 'boss:b1:m1', bossId: 'b1', hrName: '王', company: '字节', position: '前端', content: '旧', time: 1 },
        { externalId: 'boss:b2:m2', bossId: 'b2', hrName: '李', company: '美团', position: 'PM', content: '新', time: 2 },
      ];

      const result = await usecase.execute({ kind: 'recruit', messages });

      expect(result.accepted).toBe(1);
      expect(result.deduplicated).toBe(1);
      expect(state.sentMessages.length).toBe(1);
      expect(state.sentMessages[0].body).toContain('美团');
      expect(state.sentMessages[0].body).not.toContain('字节');
    });

    it('批内重复 externalId 也被去重', async () => {
      const messages = [
        { externalId: 'dup', bossId: 'b1', hrName: '王', company: '字节', position: '前端', content: 'a', time: 1 },
        { externalId: 'dup', bossId: 'b1', hrName: '王', company: '字节', position: '前端', content: 'a', time: 1 },
      ];
      const result = await usecase.execute({ kind: 'recruit', messages });
      expect(result.accepted).toBe(1);
      expect(result.deduplicated).toBe(1);
    });

    it('未初始化专用对话时抛错', async () => {
      instances.settingsRepo.get = vi.fn(async () => null);
      await expect(usecase.execute({ kind: 'recruit', messages: [] }))
        .rejects.toThrow(/not initialized/);
    });
  });

  describe('status kind', () => {
    it('每个 warning/critical 事件一条系统消息 + 一次 invoke', async () => {
      const events = [
        { type: 'anti-bot-detected', severity: 'critical' as const, detail: 'about:blank', at: '2026-08-04T10:00:00Z' },
        { type: 'scan-zero-unexpected', severity: 'warning' as const, at: '2026-08-04T10:01:00Z' },
      ];
      const result = await usecase.execute({ kind: 'status', events });
      expect(result.accepted).toBe(2);
      expect(state.sentMessages.length).toBe(2);
      expect(state.sentMessages[0].body).toContain('[桥接状态·🔴 critical]');
      expect(state.sentMessages[1].body).toContain('[桥接状态·🟡 warning]');
      await flushAsync();
      expect(state.executeChainCalls.length).toBe(2);
    });

    it('空 events 直接返回不写入', async () => {
      const result = await usecase.execute({ kind: 'status', events: [] });
      expect(result.accepted).toBe(0);
      expect(state.sentMessages.length).toBe(0);
    });
  });
});
