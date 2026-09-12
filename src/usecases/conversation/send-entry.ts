/**
 * SendEntry - 条目发送与 invoke 生命周期管理（F20260910ctlv 彻底切换）
 *
 * 切换后唯一时间线真相源：
 * - entries 表 = 时间线唯一数据源（user/speak/system/invoke_start/invoke_end/yield）
 * - invokes 表 = invoke 生命周期唯一状态机
 * - invoke_events 表 = 流式过程唯一存储
 * - messages 表停写 UI 消息（memory/FTS/飞书依赖后续迁移，本轮不管）
 *
 * user 消息目标解析（路由点火前置依赖）已从 SendMessage 搬到 resolveSendTargets。
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
import { tryCloseTurn, ensureActiveTurn } from "./turn-utils";
import { resolveSendTargets, type ResolveTargetsDeps } from "./resolve-send-targets";

/** 用户发送条目输入 */
export interface SendUserEntryInput {
  conversationId: string;
  senderId: string;
  body: string;
  /** 空 = 默认派发解析；显式 = @点名/卡片路由 */
  talkingStonePassedTo?: string[];
  source?: EntrySource;
  metadata?: EntryMetadata | null;
  attachmentIds?: string[];
  /** F20260826fuid：飞书群聊多人识别的发送者显示名快照（存 metadata.senderDisplayName） */
  senderDisplayName?: string | null;
  /** F20260910ctlv：注入方式（目标 running 时）——落 metadata.injectionMode，
   *  signal-router running 分支消费（steer=打断默认/followUp=排队） */
  injectionMode?: "steer" | "followUp";
}

/** 创建 invoke 输入 */
export interface CreateInvokeInput {
  conversationId: string;
  otterId: string;
  triggerEntryId?: string;
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
  /** F20260910ctlv 收尾批2：scheduler 内部信号——yieldTargets 即信号目标（原 messages.talkingStonePassedTo）。
   *  仅 scheduler 生产者使用；无目标的居中系统条目不传 */
  yieldTargets?: string[];
  senderName?: string;
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
    /** F20260910ctlv 彻底切换：logger + 目标解析依赖（未注入 resolveDeps 时 sendUserEntry
     *  不解析目标，由入口预解析；logger 独立成字段以保持构造 ≤5 参） */
    private readonly aux: { logger: Logger; resolveDeps?: ResolveTargetsDeps },
  ) {
    this.logger = aux.logger;
  }

  private readonly logger: Logger;

  /**
   * 用户发送条目（立即 completed）。
   * 彻底切换：user 消息唯一落点（messages 表不再写入）。
   * 未预解析目标时在此解析（默认派发 / @提及），路由点火方消费返回的 talkingStonePassedTo。
   */
  async sendUserEntry(input: SendUserEntryInput): Promise<{ entry: Entry; talkingStonePassedTo: string[]; mentionFeedback?: string }> {
    const turn = await this.ensureActiveTurn(input.conversationId);

    /** 目标解析：显式目标直用；空则走默认派发链（resolveDeps 未注入时空数组——入口必须预解析） */
    let talkingStonePassedTo = input.talkingStonePassedTo ?? [];
    let mentionFeedback: string | undefined;
    if (talkingStonePassedTo.length === 0 && this.aux.resolveDeps) {
      const resolved = await resolveSendTargets({
        deps: this.aux.resolveDeps, logger: this.logger, conversationId: input.conversationId, explicit: [], body: input.body, senderType: "user",
      });
      talkingStonePassedTo = resolved.targets;
      mentionFeedback = resolved.feedback;
    }

    const now = new Date().toISOString();
    const entry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum: 0, // 原子分配（createEntryAtomic 忽略入参）
      entryType: "user",
      senderType: "user",
      senderId: input.senderId,
      body: input.body,
      invokeId: null,
      /** F20260910ctlv 补漏：user entry 的发言石目标 = 点火依据（信号路由读此字段） */
      yieldTargets: talkingStonePassedTo,
      turnId: turn.id,
      status: "completed",
      source: input.source ?? "web",
      // F20260910ctlv：注入方式落 metadata（与 senderDisplayName 合并——两者可同时存在）
      metadata: this.buildUserEntryMetadata(input),
      senderName: input.senderDisplayName?.trim() ?? "",
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    const created = await this.entryRepo.createEntryAtomic(entry);

    // 尝试关闭 Turn（user entry 已是终态；同 turn 内无 running invoke 时关闭）
    await tryCloseTurn(this.conversationRepo, turn.id, { invokeRepo: this.invokeRepo, entryRepo: this.entryRepo });

    this.logger.info('User entry sent', {
      conversationId: input.conversationId,
      entryId: created.id,
      senderId: input.senderId,
      bodyLength: input.body.length,
      talkingStonePassedTo,
    });

    return { entry: created, talkingStonePassedTo, mentionFeedback };
  }

  /** 组装 user entry metadata：显式 metadata / senderDisplayName / injectionMode 三者合并（可同存） */
  private buildUserEntryMetadata(input: SendUserEntryInput): EntryMetadata | null {
    const displayName = input.senderDisplayName?.trim();
    const base: EntryMetadata | null = input.metadata
      ?? (displayName ? { senderDisplayName: displayName } as EntryMetadata : null);
    if (!input.injectionMode) return base;
    return { ...(base ?? {}), injectionMode: input.injectionMode };
  }

  /** 创建 invoke 记录 + invoke_start 条目（invoke 生命周期唯一入口） */
  async createInvoke(input: CreateInvokeInput): Promise<InvokeResult> {
    const otter = await this.otterRepo.getById(input.otterId);
    if (!otter) {
      throw new DomainError(`createInvoke: otterId 不存在: ${input.otterId}`, "not_found");
    }

    const turn = await this.ensureActiveTurn(input.conversationId);
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
      sequenceNum: 0,
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

    const createdEntry = await this.entryRepo.createEntryAtomic(invokeStartEntry);

    this.logger.info('Invoke created', {
      invokeId: invoke.id,
      otterId: input.otterId,
      conversationId: input.conversationId,
    });

    return { invoke, invokeStartEntry: createdEntry };
  }

  /** 创建 speak 条目（speak 工具调用时——獭气泡唯一来源） */
  async createSpeakEntry(input: CreateSpeakEntryInput): Promise<SpeakEntryResult> {
    const otter = await this.otterRepo.getById(input.otterId);
    if (!otter) {
      throw new DomainError(`createSpeakEntry: otterId 不存在: ${input.otterId}`, "not_found");
    }

    // 空 turnId 时兜底 ensureActiveTurn（entries.turn_id FK 引用 turns.id）
    const turnId = input.turnId || (await this.ensureActiveTurn(input.conversationId)).id;

    const now = new Date().toISOString();

    const entry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum: 0,
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

    const created = await this.entryRepo.createEntryAtomic(entry);

    this.logger.info('Speak entry created', {
      entryId: created.id,
      invokeId: input.invokeId,
      otterId: input.otterId,
    });

    return { entry: created };
  }

  /** 创建 yield 条目 + invoke_end 条目 + 更新 invoke 记录（yield 工具调用时）
   *  彻底切换：yield = invoke 正常完成的唯一信号（成功检测判据） */
  // eslint-disable-next-line max-lines-per-function -- invoke 生命周期管理需要多步骤
  async createYieldEntry(input: CreateYieldEntryInput): Promise<YieldEntryResult> {
    const otter = await this.otterRepo.getById(input.otterId);
    if (!otter) {
      throw new DomainError(`createYieldEntry: otterId 不存在: ${input.otterId}`, "not_found");
    }

    const now = new Date().toISOString();
    // 空 turnId 兜底 ensureActiveTurn（entries.turn_id FK 引用 turns.id）
    const turnId = input.turnId || (await this.ensureActiveTurn(input.conversationId)).id;

    // 更新 invoke 记录：设置 tsp + status=completed
    await this.invokeRepo.updateInvokeTalkingStonePassedTo(input.invokeId, input.yieldTargets);
    await this.invokeRepo.updateInvokeStatus(input.invokeId, "completed", now);

    // 获取更新后的 invoke
    const invoke = await this.invokeRepo.getInvokeById(input.invokeId);
    if (!invoke) {
      throw new DomainError(`createYieldEntry: invoke 不存在: ${input.invokeId}`, "not_found");
    }

    // 创建 yield 条目 + invoke_end 条目（原子序号批量插入，天然连续递增）
    const yieldEntry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum: 0,
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

    const invokeEndEntry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum: 0,
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

    const created = await this.entryRepo.createEntriesAtomic([yieldEntry, invokeEndEntry]);

    // 尝试关闭 Turn（本 invoke 已终态；同 turn 无 running invoke 时关闭）
    await tryCloseTurn(this.conversationRepo, turnId, { invokeRepo: this.invokeRepo, entryRepo: this.entryRepo });

    this.logger.info('Yield entry created', {
      invokeId: input.invokeId,
      yieldTargets: input.yieldTargets,
      otterId: input.otterId,
    });

    return { yieldEntry: created[0]!, invokeEndEntry: created[1]!, invoke };
  }

  /** 创建 invoke_end 条目（fail/abort 时） */
  async createInvokeEndEntry(input: CreateInvokeEndEntryInput): Promise<{ invokeEndEntry: Entry; invoke: Invoke }> {
    const otter = await this.otterRepo.getById(input.otterId);
    if (!otter) {
      throw new DomainError(`createInvokeEndEntry: otterId 不存在: ${input.otterId}`, "not_found");
    }

    const now = new Date().toISOString();
    // 空 turnId 兜底 ensureActiveTurn
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
      sequenceNum: 0,
      entryType: "invoke_end",
      senderType: null,
      senderId: null,
      body,
      invokeId: input.invokeId,
      yieldTargets: null,
      turnId,
      status: "completed",
      source: null,
      /** F20260910ctlv test17：invoke 真实终态记 metadata.invokeStatus——entries.status
       *  是死字段（全部 completed），历史渲染靠它识别可重试条目（重试按钮数据源） */
      metadata: input.status !== "completed" ? { invokeStatus: input.status } : null,
      senderName: otter.name,
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    const created = await this.entryRepo.createEntryAtomic(invokeEndEntry);

    // 尝试关闭 Turn（fail/abort 也是终态）
    await tryCloseTurn(this.conversationRepo, turnId, { invokeRepo: this.invokeRepo, entryRepo: this.entryRepo });

    this.logger.info('Invoke end entry created', {
      invokeId: input.invokeId,
      status: input.status,
      otterId: input.otterId,
    });

    return { invokeEndEntry: created, invoke };
  }

  /** 创建系统条目 */
  async createSystemEntry(input: CreateSystemEntryInput): Promise<{ entry: Entry }> {
    const now = new Date().toISOString();
    // 空 turnId 兜底 ensureActiveTurn
    const turnId = input.turnId || (await this.ensureActiveTurn(input.conversationId)).id;

    const entry: Entry = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequenceNum: 0,
      entryType: "system",
      senderType: "system",
      senderId: "system",
      body: input.body,
      invokeId: null,
      yieldTargets: input.yieldTargets ?? null,
      turnId,
      status: "completed",
      source: null,
      metadata: null,
      senderName: input.senderName ?? "system",
      contextTokens: null,
      contextTokensMax: null,
      createdAt: now,
      completedAt: now,
    };

    const created = await this.entryRepo.createEntryAtomic(entry);

    this.logger.info('System entry created', {
      entryId: created.id,
      conversationId: input.conversationId,
    });

    return { entry: created };
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

  /** 更新 invoke 状态（orchestrator 终态回调） */
  async updateInvokeStatus(invokeId: string, status: 'completed' | 'failed' | 'aborted'): Promise<void> {
    await this.invokeRepo.updateInvokeStatus(invokeId, status, new Date().toISOString());
  }

  /** 更新 invoke 发言石去向（abort/no_yield 耗尽时回传触发者） */
  async updateInvokeTalkingStonePassedTo(invokeId: string, targets: string[]): Promise<void> {
    await this.invokeRepo.updateInvokeTalkingStonePassedTo(invokeId, targets);
  }

  /** F20260910ctlv 彻底切换：user entry 挂附件（多模态 Phase 1 接线） */
  async attachEntryAttachments(entryId: string, attachmentIds: string[]): Promise<void> {
    for (let i = 0; i < attachmentIds.length; i++) {
      await this.entryRepo.attachAttachment(entryId, attachmentIds[i]!, i);
    }
  }

  /** 确保存在活跃 Turn */
  private async ensureActiveTurn(conversationId: string) {
    // 共享实现上提至 turn-utils（manage-participant join 同源复用）
    return ensureActiveTurn(this.conversationRepo, conversationId);
  }
}
