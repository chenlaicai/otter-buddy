import type { MessageMetadata } from '@entities/conversation/message';
import {
  RECRUITING_CONVERSATION_KEY,
  RECRUITING_BIG_OTTER_ID_KEY,
  RECRUITING_LAST_BRIDGE_EVENT_AT_KEY,
} from './constants';
import type { SettingsRepository } from '@usecases/settings/settings-repository';
import type { QueryMessage } from '@usecases/conversation/query-message';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { DispatchChainEngine, InvokeFn } from '@usecases/conversation/dispatch-chain-engine';
import type { AgentInvokePort } from '@usecases/scheduler/agent-invoke-port';
import type { Logger } from '@usecases/ports/logger';

/** 扩展推送的招聘消息元素 */
export interface RecruitMessageInput {
  /** 查重 ID：`boss:{bossId}:{mid}` */
  externalId: string;
  bossId: string;
  mid?: string;
  hrName: string;
  hrTitle?: string;
  company: string;
  position: string;
  /** 消息正文 */
  content: string;
  /** BOSS time 字段（unix ms） */
  time: number;
}

/** 扩展推送的状态事件元素 */
export interface StatusEventInput {
  type: string;
  severity: 'warning' | 'critical';
  detail?: string;
  /** ISO string */
  at: string;
}

/** inbound 端点接收的 payload（外部使用） */
export type InboundPayload =
  | { kind: 'recruit'; messages: RecruitMessageInput[] }
  | { kind: 'status'; events: StatusEventInput[] };

export interface ProcessResult {
  accepted: number;
  deduplicated: number;
}

/**
 * F20260804rbrg：处理外部桥接（boss-zhipin-bridge）推送的入站事件。
 *
 * **关键设计：一次扫描 = 一条系统消息 = 一次大獭 invoke**
 *
 * 扩展端一次扫描可能发现 N 条新消息（多个 bossId 各有新消息）。本用例把整批组装成
 * **一条**系统消息插入专用对话，大獭一次 invoke 处理整批——可以跨公司排序（面试邀请
 * 排首位）、去重、给整体摘要开篇。这比逐条 invoke 更省成本、质量更高。
 *
 * 派发链路：构造系统消息时显式设 `talkingStonePassedTo: [bigOtterId]`（不依赖
 * resolveUserTargets 默认解析），然后直接调 `DispatchChainEngine.executeChain`，
 * 不走 `AgentDispatchService`（ADS 的 resolveFirstTurnTargets 查 senderType:"user"
 * 最近消息，inbound 是系统消息，复用走不通）。
 */
export class ProcessInboundRecruit {
  // eslint-disable-next-line max-params -- 7 个 DI 依赖均为必需
  constructor(
    private readonly settings: SettingsRepository,
    private readonly queryMessage: QueryMessage,
    private readonly sendMessage: SendMessage,
    private readonly dispatchChainEngine: DispatchChainEngine,
    private readonly agentInvokePort: AgentInvokePort,
    private readonly logger: Logger,
  ) {}

  async execute(payload: InboundPayload): Promise<ProcessResult> {
    // 1. 拿专用对话 + big otter
    const conversationId = await this.settings.get(RECRUITING_CONVERSATION_KEY);
    const bigOtterId = await this.settings.get(RECRUITING_BIG_OTTER_ID_KEY);
    if (!conversationId || !bigOtterId) {
      throw new Error('Recruiting conversation not initialized. Run ensureRecruitingConversation on boot.');
    }

    // 记录扩展活动时间戳（用于诊断"扩展是否在跑"），不阻塞主流程
    void this.settings.update(RECRUITING_LAST_BRIDGE_EVENT_AT_KEY, new Date().toISOString()).catch(() => {});

    if (payload.kind === 'recruit') {
      return this.handleRecruit(conversationId, bigOtterId, payload.messages);
    }
    return this.handleStatus(conversationId, bigOtterId, payload.events);
  }

  /** 招聘消息批次：查重 → 组装批量系统消息 → 入库 → 触发大獭一次 invoke */
  private async handleRecruit(
    conversationId: string,
    bigOtterId: string,
    messages: RecruitMessageInput[],
  ): Promise<ProcessResult> {
    if (messages.length === 0) {
      return { accepted: 0, deduplicated: 0 };
    }

    // 1. externalId 查重
    const seen = new Set<string>();
    const fresh: RecruitMessageInput[] = [];
    let deduplicated = 0;
    for (const m of messages) {
      if (seen.has(m.externalId)) {
        deduplicated++;
        continue;
      }
      const existing = await this.queryMessage.findByExternalId(m.externalId);
      if (existing) {
        deduplicated++;
        continue;
      }
      seen.add(m.externalId);
      fresh.push(m);
    }

    if (fresh.length === 0) {
      this.logger.info('inbound recruit: all messages deduplicated', { count: messages.length });
      return { accepted: 0, deduplicated };
    }

    // 2. 组装批量系统消息 body
    const body = formatRecruitBatch(fresh);

    // 3. 入库：metadata 标记 externalIds（便于后续追溯/查重），单条系统消息
    const externalIds = fresh.map(m => m.externalId);
    const metadata: MessageMetadata = {
      externalId: externalIds.join('|'),
    };
    const message = await this.sendMessage.send({
      conversationId,
      senderType: 'system',
      senderId: 'boss-zhipin-bridge',
      talkingStonePassedTo: [bigOtterId],
      body,
      metadata,
    });

    this.logger.info('inbound recruit: batch inserted', {
      conversationId,
      messageId: message.id,
      accepted: fresh.length,
      deduplicated,
    });

    // 4. 触发大獭一次 invoke（fire-and-forget，错误不影响响应）
    void this.triggerDispatch(conversationId, bigOtterId, body).catch(err => {
      this.logger.error(
        'inbound recruit: dispatch failed',
        err instanceof Error ? err : new Error(String(err)),
        { conversationId, messageId: message.id },
      );
    });

    return { accepted: fresh.length, deduplicated };
  }

  /** 桥接状态事件：每个事件插入系统消息 → 触发大獭 invoke */
  private async handleStatus(
    conversationId: string,
    bigOtterId: string,
    events: StatusEventInput[],
  ): Promise<ProcessResult> {
    if (events.length === 0) {
      return { accepted: 0, deduplicated: 0 };
    }

    let accepted = 0;
    for (const event of events) {
      // 状态事件无 externalId 查重（30 分钟去重在扩展端做）。每个事件一条系统消息
      const body = formatStatusEvent(event);
      const metadata: MessageMetadata = {
        eventType: event.type,
        severity: event.severity,
      };
      const message = await this.sendMessage.send({
        conversationId,
        senderType: 'system',
        senderId: 'boss-zhipin-bridge',
        talkingStonePassedTo: [bigOtterId],
        body,
        metadata,
      });

      this.logger.info('inbound status: event inserted', {
        conversationId,
        messageId: message.id,
        type: event.type,
        severity: event.severity,
      });

      void this.triggerDispatch(conversationId, bigOtterId, body).catch(err => {
        this.logger.error(
          'inbound status: dispatch failed',
          err instanceof Error ? err : new Error(String(err)),
          { conversationId, messageId: message.id, type: event.type },
        );
      });

      accepted++;
    }

    return { accepted, deduplicated: 0 };
  }

  /** bypass AgentDispatchService 直接调 executeChain，invokeFn 内部构造 */
  private async triggerDispatch(
    conversationId: string,
    bigOtterId: string,
    userMessageContent: string,
  ): Promise<void> {
    const invokeFn: InvokeFn = async ({ otterId, conversationId, userMessageContent, senderId }) =>
      this.agentInvokePort.invokeConversation({
        otterId,
        conversationId,
        userMessageContent,
        senderId,
      });

    await this.dispatchChainEngine.executeChain({
      conversationId,
      userMessageContent,
      senderId: 'boss-zhipin-bridge',
      initialTargets: [bigOtterId],
      invokeFn,
    });
  }
}

/** 把一批招聘消息格式化为一条系统消息 body */
function formatRecruitBatch(messages: RecruitMessageInput[]): string {
  const scanTime = new Date().toISOString();
  const lines: string[] = [
    `[招聘消息批次·BOSS直聘·扫描时间 ${scanTime}]`,
    `共 ${messages.length} 条新消息：`,
    '',
  ];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const hrLine = m.hrTitle ? `${m.hrName}（${m.hrTitle}）` : m.hrName;
    const timeStr = new Date(m.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    lines.push(`▌消息 ${i + 1} / HR：${hrLine} / 公司：${m.company} / 职位：${m.position}`);
    lines.push(`时间：${timeStr}`);
    lines.push('---');
    lines.push(m.content);
    lines.push('');
  }

  return lines.join('\n');
}

/** 把单个状态事件格式化为系统消息 body */
function formatStatusEvent(event: StatusEventInput): string {
  const icon = event.severity === 'critical' ? '🔴' : '🟡';
  const lines: string[] = [
    `[桥接状态·${icon} ${event.severity}] ${event.type}`,
  ];
  if (event.detail) {
    lines.push(`详情：${event.detail}`);
  }
  lines.push(`时间：${event.at}`);
  return lines.join('\n');
}
