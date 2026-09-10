/**
 * SendEntry - 条目发送与 invoke 生命周期管理（F20260910ctlv）
 *
 * 职责：
 * - 创建各类 entry（speak/user/system/invoke_start/invoke_end/yield）
 * - 管理 invoke 生命周期（创建/更新/结束）
 * - 取代 SendMessage 中的消息管理逻辑
 */

import { DomainError } from "@entities/errors";
import type {
  Entry,
  EntrySource,
  EntryMetadata,
} from "@entities/conversation/entry";
import type {
  Invoke,
  InvokeEvent,
  InvokeEventType,
} from "@entities/conversation/invoke";
import type { EntryRepository } from "./entry-repository";
import type { InvokeRepository } from "./invoke-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { ConversationRepository } from "./conversation-repository";
import type { Logger } from "@usecases/ports/logger";
import { resolveSpeakerName } from "./speaker-resolver";
import { tryCloseTurn } from "./turn-utils";

/** 用户发送条目输入 */
export interface SendUserEntryInput {
  conversationId: string;
  senderId: string;
  body: string;
  source?: EntrySource;
  metadata?: EntryMetadata | null;
  attachmentIds?: string[];
}

/** 创建 invoke 输入 */
export interface CreateInvokeInput {
  conversationId: string;
  otterId: string;
  triggerEntryId?: string;
}

/** 创建 invoke_start 条目输入 */
export interface CreateInvokeStartEntryInput {
  conversationId: string;
  invokeId: string;
  otterId: string;
  turnId: string;
}

/** 创建 speak 条目输入 */
export interface CreateSpeakEntryInput {
  conversationId: string;
  invokeId: string;
  otterId: string;
  turnId: string;
  body: string;
}

/** 创建 yield 条目输入 */
export interface CreateYieldEntryInput {
  conversationId: string;
  invokeId: string;
  otterId: string;
  turnId: string;
  yieldTargets: string[];
}

/** 创建 invoke_end 条目输入 */
export interface CreateInvokeEndEntryInput {
  conversationId: string;
  invokeId: string;
  otterId: string;
  turnId: string;
  status: "completed" | "failed" | "aborted";
  body?: string;
}

/** 创建系统条目输入 */
export interface CreateSystemEntryInput {
  conversationId: string;
  turnId: string;
  body: string;
}

/** invoke 结果 */
export interface InvokeResult {
  invoke: Invoke;
  invokeStartEntry: Entry;
}

/** speak 条目结果 */
export interface SpeakEntryResult {
  entry: Entry;
}

/** yield 条目结果 */
export interface YieldEntryResult {
  yieldEntry: Entry;
  invokeEndEntry: Entry;
  invoke: Invoke;
}

export class SendEntry {
  constructor(
    private readonly entryRepo: EntryRepository,
    private readonly invokeRepo: InvokeRepository,
    private readonly otterRepo: OtterRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly logger: Logger,
  ) {}

  /** 用户发送条目（立即 completed） */
  async sendUserEntry(input: SendUserEntryInput): Promise<{ entry: Entry }> {
    const turn = await this.ensureActiveTurn(input.conversationId);
    const sequenceNum = await this.entryRepo.getMaxSequenceNum(input.conversationId) + 1;

    const entry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum,
      entryType: "user",
      senderType: "user",
      senderId: input.senderId,
      body: input.body,
      invokeId: null,
      yieldTargets: null,
      turnId: turn.id,
      status: "completed",
      source: input.source ?? "web",
      metadata: input.metadata ?? null,
      senderName: "",
      contextTokens: null,
      contextTokensMax: null,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    await this.entryRepo.createEntry(entry);

    // 尝试关闭 Turn
    await tryCloseTurn(this.conversationRepo, turn.id);

    this.logger.info('User entry sent', {
      conversationId: input.conversationId,
      entryId: entry.id,
      senderId: input.senderId,
      bodyLength: input.body.length,
    });

    return { entry };
  }

  /** 创建 invoke 记录 + invoke_start 条目 */
  async createInvoke(input: CreateInvokeInput): Promise<InvokeResult> {
    const otter = await this.otterRepo.getById(input.otterId);
    if (!otter) {
      throw new DomainError(`createInvoke: otterId 不存在: ${input.otterId}`, "not_found");
    }

    const turn = await this.ensureActiveTurn(input.conversationId);
    const sequenceNum = await this.entryRepo.getMaxSequenceNum(input.conversationId) + 1;
    const now = new Date().toISOString();

    // 创建 invoke 记录
    const invoke: Invoke = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      otterId: input.otterId,
      status: "running",
      triggerEntryId: input.triggerEntryId ?? null,
      talkingStonePassedTo: null,
      startedAt: now,
      endedAt: null,
      toolCallCount: 0,
      tokenUsageInput: null,
      tokenUsageOutput: null,
      metadata: null,
    };

    await this.invokeRepo.createInvoke(invoke);

    // 创建 invoke_start 条目
    const invokeStartEntry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum,
      entryType: "invoke_start",
      senderType: null,
      senderId: null,
      body: `🦦 ${otter.name}开始行动～`,
      invokeId: invoke.id,
      yieldTargets: null,
      turnId: turn.id,
      status: "completed",
      source: null,
      metadata: null,
      senderName: otter.name,
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    await this.entryRepo.createEntry(invokeStartEntry);

    this.logger.info('Invoke created', {
      invokeId: invoke.id,
      otterId: input.otterId,
      conversationId: input.conversationId,
    });

    return { invoke, invokeStartEntry };
  }

  /** 创建 speak 条目（speak 工具调用时） */
  async createSpeakEntry(input: CreateSpeakEntryInput): Promise<SpeakEntryResult> {
    const otter = await this.otterRepo.getById(input.otterId);
    if (!otter) {
      throw new DomainError(`createSpeakEntry: otterId 不存在: ${input.otterId}`, "not_found");
    }

    // F20260910ctlv 实测修复：调用方传空 turnId 时兜底 ensureActiveTurn（entries.turn_id FK 引用 turns.id）
    const turnId = input.turnId || (await this.ensureActiveTurn(input.conversationId)).id;

    const sequenceNum = await this.entryRepo.getMaxSequenceNum(input.conversationId) + 1;
    const now = new Date().toISOString();

    const entry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum,
      entryType: "speak",
      senderType: "otter",
      senderId: input.otterId,
      body: input.body,
      invokeId: input.invokeId,
      yieldTargets: null,
      turnId,
      status: "completed",
      source: null,
      metadata: null,
      senderName: resolveSpeakerName("otter", input.otterId, otter.name) ?? otter.name,
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    await this.entryRepo.createEntry(entry);

    this.logger.info('Speak entry created', {
      entryId: entry.id,
      invokeId: input.invokeId,
      otterId: input.otterId,
    });

    return { entry };
  }

  /** 创建 yield 条目 + invoke_end 条目 + 更新 invoke 记录 */
  // eslint-disable-next-line max-lines-per-function -- invoke 生命周期管理需要多步骤
  async createYieldEntry(input: CreateYieldEntryInput): Promise<YieldEntryResult> {
    const otter = await this.otterRepo.getById(input.otterId);
    if (!otter) {
      throw new DomainError(`createYieldEntry: otterId 不存在: ${input.otterId}`, "not_found");
    }

    const now = new Date().toISOString();
    const baseSequenceNum = await this.entryRepo.getMaxSequenceNum(input.conversationId) + 1;
    // F20260910ctlv 实测修复：空 turnId 兜底 ensureActiveTurn（entries.turn_id FK 引用 turns.id）
    const turnId = input.turnId || (await this.ensureActiveTurn(input.conversationId)).id;

    // 更新 invoke 记录：设置 tsp + status=completed
    await this.invokeRepo.updateInvokeTalkingStonePassedTo(input.invokeId, input.yieldTargets);
    await this.invokeRepo.updateInvokeStatus(input.invokeId, "completed", now);

    // 获取更新后的 invoke
    const invoke = await this.invokeRepo.getInvokeById(input.invokeId);
    if (!invoke) {
      throw new DomainError(`createYieldEntry: invoke 不存在: ${input.invokeId}`, "not_found");
    }

    // 创建 yield 条目
    const yieldEntry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum: baseSequenceNum,
      entryType: "yield",
      senderType: null,
      senderId: null,
      body: `→ 交给 ${input.yieldTargets.join(", ")}`,
      invokeId: input.invokeId,
      yieldTargets: input.yieldTargets,
      turnId,
      status: "completed",
      source: null,
      metadata: null,
      senderName: otter.name,
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    // 创建 invoke_end 条目
    const invokeEndEntry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum: baseSequenceNum + 1,
      entryType: "invoke_end",
      senderType: null,
      senderId: null,
      body: `🦦 ${otter.name}先休息一下～`,
      invokeId: input.invokeId,
      yieldTargets: null,
      turnId,
      status: "completed",
      source: null,
      metadata: null,
      senderName: otter.name,
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    await this.entryRepo.createEntries([yieldEntry, invokeEndEntry]);

    this.logger.info('Yield entry created', {
      invokeId: input.invokeId,
      yieldTargets: input.yieldTargets,
      otterId: input.otterId,
    });

    return { yieldEntry, invokeEndEntry, invoke };
  }

  /** 创建 invoke_end 条目（fail/abort 时） */
  async createInvokeEndEntry(input: CreateInvokeEndEntryInput): Promise<{ invokeEndEntry: Entry; invoke: Invoke }> {
    const otter = await this.otterRepo.getById(input.otterId);
    if (!otter) {
      throw new DomainError(`createInvokeEndEntry: otterId 不存在: ${input.otterId}`, "not_found");
    }

    const now = new Date().toISOString();
    const sequenceNum = await this.entryRepo.getMaxSequenceNum(input.conversationId) + 1;
    // F20260910ctlv 实测修复：空 turnId 兜底 ensureActiveTurn
    const turnId = input.turnId || (await this.ensureActiveTurn(input.conversationId)).id;

    // 更新 invoke 记录状态
    await this.invokeRepo.updateInvokeStatus(input.invokeId, input.status, now);

    // 获取更新后的 invoke
    const invoke = await this.invokeRepo.getInvokeById(input.invokeId);
    if (!invoke) {
      throw new DomainError(`createInvokeEndEntry: invoke 不存在: ${input.invokeId}`, "not_found");
    }

    // 构造 invoke_end 条目 body
    let body: string;
    if (input.body) {
      body = input.body;
    } else {
      switch (input.status) {
        case "failed":
          body = `🦦 ${otter.name}行动失败`;
          break;
        case "aborted":
          body = `🦦 ${otter.name}被中断`;
          break;
        default:
          body = `🦦 ${otter.name}先休息一下～`;
      }
    }

    const invokeEndEntry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum,
      entryType: "invoke_end",
      senderType: null,
      senderId: null,
      body,
      invokeId: input.invokeId,
      yieldTargets: null,
      turnId,
      status: "completed",
      source: null,
      metadata: null,
      senderName: otter.name,
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    await this.entryRepo.createEntry(invokeEndEntry);

    this.logger.info('Invoke end entry created', {
      invokeId: input.invokeId,
      status: input.status,
      otterId: input.otterId,
    });

    return { invokeEndEntry, invoke };
  }

  /** 创建系统条目 */
  async createSystemEntry(input: CreateSystemEntryInput): Promise<{ entry: Entry }> {
    const sequenceNum = await this.entryRepo.getMaxSequenceNum(input.conversationId) + 1;
    const now = new Date().toISOString();
    // F20260910ctlv 实测修复：空 turnId 兜底 ensureActiveTurn
    const turnId = input.turnId || (await this.ensureActiveTurn(input.conversationId)).id;

    const entry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum,
      entryType: "system",
      senderType: "system",
      senderId: "system",
      body: input.body,
      invokeId: null,
      yieldTargets: null,
      turnId,
      status: "completed",
      source: null,
      metadata: null,
      senderName: "system",
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    await this.entryRepo.createEntry(entry);

    this.logger.info('System entry created', {
      entryId: entry.id,
      conversationId: input.conversationId,
    });

    return { entry };
  }

  /** 追加 invoke 事件（流式过程记录） */
  async appendInvokeEvent(
    invokeId: string,
    eventType: InvokeEventType,
    payload: Record<string, unknown>,
  ): Promise<InvokeEvent> {
    const maxSeq = await this.invokeRepo.getMaxEventSequenceNum(invokeId);
    const event: InvokeEvent = {
      id: crypto.randomUUID(),
      invokeId,
      eventType,
      payload,
      sequenceNum: maxSeq + 1,
      createdAt: new Date().toISOString(),
    };

    await this.invokeRepo.appendInvokeEvent(event);
    return event;
  }

  /** 更新 invoke 工具调用计数 */
  async incrementInvokeToolCallCount(invokeId: string): Promise<void> {
    const invoke = await this.invokeRepo.getInvokeById(invokeId);
    if (!invoke) return;
    await this.invokeRepo.updateInvokeToolCallCount(invokeId, invoke.toolCallCount + 1);
  }

  /** 更新 invoke token 使用量 */
  async updateInvokeTokenUsage(
    invokeId: string,
    input: number,
    output: number,
  ): Promise<void> {
    await this.invokeRepo.updateInvokeTokenUsage(invokeId, input, output);
  }

  /** 查询条目列表 */
  async getEntries(
    conversationId: string,
    opts?: { entryType?: string; limit?: number },
  ): Promise<Entry[]> {
    return this.entryRepo.getEntries(conversationId, {
      entryType: opts?.entryType as "speak" | "user" | "invoke_start" | "invoke_end" | "yield" | "system" | undefined,
      limit: opts?.limit,
    });
  }

  /** 获取 invoke 信息 */
  async getInvokeById(invokeId: string): Promise<Invoke | null> {
    return this.invokeRepo.getInvokeById(invokeId);
  }

  /** 更新 invoke 状态（公共方法，供 orchestrator 回调使用） */
  async updateInvokeStatus(invokeId: string, status: 'completed' | 'failed' | 'aborted'): Promise<void> {
    await this.invokeRepo.updateInvokeStatus(invokeId, status, new Date().toISOString());
  }

  /** 确保存在活跃 Turn */
  private async ensureActiveTurn(conversationId: string) {
    const turn = await this.conversationRepo.getActiveTurn(conversationId);
    if (turn) return turn;

    // 创建新 Turn
    const maxTurnNumber = await this.conversationRepo.getMaxTurnNumber(conversationId);
    const newTurn = {
      id: crypto.randomUUID(),
      conversationId,
      turnNumber: maxTurnNumber + 1,
      status: "open" as const,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    await this.conversationRepo.createTurn(newTurn);
    return newTurn;
  }
}
