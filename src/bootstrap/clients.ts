import type { MemoryContentType } from "@entities/memory/memory-entry";
import type { EdgeType } from "@entities/memory/memory-edge";
import type { ArtifactStatus } from "@entities/conversation/conversation";
import type { UseCases } from "./types";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

export function buildMessageClient(uc: UseCases) {
  return {
    startSpeaking: (messageId: string, params: { body: string; talkingStonePassedTo: string[] }) =>
      uc.sendMessage.startSpeaking(messageId, params),
    appendSegment: (messageId: string, body: string) =>
      uc.sendMessage.appendSegment(messageId, body),
    complete: (messageId: string, params?: { talkingStonePassedTo?: string[] }) =>
      uc.sendMessage.complete(messageId, params),
    getById: (id: string) => uc.queryMessage.getMessageById(id),
    list: (convId: string, opts?: { limit?: number; before?: string }) =>
      uc.queryMessage.getMessages(convId, { limit: opts?.limit, before: opts?.before }),
    search: (convId: string, query: string, limit?: number) =>
      uc.queryMessage.searchMessages(convId, query, limit),
    expand: (messageId: string, direction: "before" | "after" | "both", count: number) =>
      uc.queryMessage.expandMessage(messageId, direction, count),
    getTurnHistory: (convId: string, opts?: { includeMessages?: boolean }) =>
      uc.queryMessage.getTurnHistory(convId, opts),
    getLastBySenderType: (convId: string, senderType: "user" | "otter" | "system") =>
      uc.queryMessage.getLastMessageBySenderType(convId, senderType),
    createSpeakMessage: async (conversationId: string, senderId: string, invokeGroupId: string) => {
      // turnId 从首个 message（invokeGroupId）获取
      const firstMsg = await uc.queryMessage.getMessageById(invokeGroupId);
      const turnId = firstMsg?.turnId ?? '';
      return uc.sendMessage.createSpeakMessage(conversationId, senderId, turnId, invokeGroupId);
    },
    completeSpeakMessage: (messageId: string) =>
      uc.sendMessage.completeSpeakMessage(messageId),
    getByInvokeGroupId: (convId: string, invokeGroupId: string) =>
      uc.sendMessage.getMessagesByInvokeGroupId(convId, invokeGroupId),
  };
}

export function buildMemoryClient(uc: UseCases) {
  return {
    getById: async (id: string) => {
      const entry = await uc.manageMemory.getById(id);
      return entry ? { id: entry.id, content: entry.content, score: 1, layer: entry.layer } : null;
    },
    // F20260826rcmm Phase 0：检索埋点（fire-and-forget）。调用方（search_memory 工具）注入
    // conversationId/callerId——client 是单例，拿不到 per-request 上下文，故由 tool 层传。
    logSearch: (p: { query: string; conversationId: string; callerId: string | null; beforeMessageId?: string | null; detailLevel?: string; library?: string; limitCount?: number; topEntryIds: string[]; total: number }) => {
      // 双层防护：catch 防 Promise rejection，try/catch 防 uc 未装配时的同步 TypeError 逃逸
      // （mimo 审视：后者的工具层接线测试已实证会打挂 execute——这里一并堵死）
      try {
        uc.recordSearchQuery.record(p).catch(() => undefined); // usecase 内已 catch+warn，这里只防 Promise 外漏
      } catch {
        // 装配遗漏等同步错误同样不得影响检索主流程
      }
    },
    // eslint-disable-next-line max-params -- 合并 main 分支 contentType + recruiting createdAfter + F20260812mrcq expandContext 参数
    search: async (query: string, limit?: number, detailLevel?: "summary" | "snippet" | "full", library?: string, createdAfter?: string, contentType?: MemoryContentType[], expandContext?: boolean) => {
      const result = await uc.searchMemory.search({ query, limit: limit ?? 10, detailLevel, library, createdAfter, contentType, expandContext });
      const mapEntry = (e: { id: string; content: string; score: number; layer: string; snippet?: string; contentType: string; metadata: Record<string, unknown> | null; createdAt: string }) => ({
        id: e.id, content: e.content, score: e.score, layer: e.layer, snippet: e.snippet,
        contentType: e.contentType, metadata: e.metadata ?? undefined, createdAt: e.createdAt,
      });
      return {
        entries: result.entries.map(mapEntry),
        // F20260826rcmp 审视修正：透传检索真值 total——埋点/失败分类用（区分「只找到 N 条」vs「命中多返回 top-k」）
        total: result.total,
        // F20260812mrcq Part 2 审视二轮 B1: agent 路径透传 contextEntries
        ...(result.contextEntries ? { contextEntries: result.contextEntries.map(mapEntry) } : {}),
        // F20260821evaf 二轮审视: agent 路径透传 vecCoverage——移除 otter_context 降级告警后，
        // 这是 agent 感知 FTS-only 降级/暗化条目的唯一通道（此前只到 HTTP 端点，工具 description 却已承诺）
        vecCoverage: result.vecCoverage,
      };
    },
    getDetails: async (ids: string[]) => {
      const entries = await uc.manageMemory.getDetails(ids);
      return entries.map(e => ({ id: e.id, content: e.content, layer: e.layer, contentType: e.contentType, metadata: e.metadata ?? undefined, createdAt: e.createdAt }));
    },
    // F20260813mren: 记忆关系层工具方法
    linkMemory: async (params: { fromId: string; toId: string; edgeType: EdgeType; note?: string }, createdBy?: string) => {
      const edgeId = await uc.createEdge.execute({
        fromEntryId: params.fromId,
        toEntryId: params.toId,
        edgeType: params.edgeType,
        metadata: params.note ? { note: params.note } : undefined,
        createdBy,
      });
      return { edgeId };
    },
    getRelated: (params: { entryId: string; depth?: number; edgeTypes?: EdgeType[]; direction?: "out" | "in"; limit?: number }) =>
      uc.getRelated.execute(params),
    unlinkEdge: (edgeId: string) => uc.deleteEdge.execute(edgeId),
    getDocProvenance: async (entryId: string) => {
      const result = await uc.getDocProvenance.execute(entryId);
      return {
        conversationId: result.conversationId,
        messages: result.messages.map(m => ({
          id: m.id, content: m.content, layer: m.layer, score: 0,
          contentType: m.contentType, metadata: m.metadata ?? undefined, createdAt: m.createdAt,
        })),
      };
    },
  };
}

export function buildResourceClient(uc: UseCases) {
  return {
    link: (input: {
      conversationId: string;
      resourceType?: string;
      url?: string;
      title?: string;
      content?: string;
      category?: string;
      linkedBy: string;
      groupId?: string;
    }, currentTurnNumber?: number) =>
      uc.manageKeyInfo.linkResource({
        conversationId: input.conversationId,
        resourceType: input.resourceType ?? "url",
        url: input.url,
        title: input.title,
        content: input.content,
        category: input.category,
        linkedBy: input.linkedBy,
        autoLinked: false,
        groupId: input.groupId,
      }, currentTurnNumber),
    list: (convId: string, filters?: { status?: ArtifactStatus; resourceType?: string }) =>
      uc.manageKeyInfo.getLinkedResources(convId, filters),
    listByGroup: (convId: string, groupId: string) =>
      uc.manageKeyInfo.getLinkedResourcesByGroup(convId, groupId),
    updateStatus: (id: string, status: "active" | "superseded" | "archived", turnNum: number, supersededBy?: string) =>
      uc.manageKeyInfo.updateResourceStatus(id, status, turnNum, supersededBy),
    supersede: (existingId: string, newInput: { conversationId: string; resourceType?: string; url?: string; title?: string; content?: string; category?: string; linkedBy: string; groupId?: string }, turnNum: number) =>
      uc.manageKeyInfo.supersedeResource(existingId, {
        conversationId: newInput.conversationId,
        resourceType: newInput.resourceType ?? "url",
        url: newInput.url,
        title: newInput.title,
        content: newInput.content,
        category: newInput.category,
        linkedBy: newInput.linkedBy,
        autoLinked: false,
        groupId: newInput.groupId,
      }, turnNum),
    archive: (id: string, convId: string, turnNum: number) =>
      uc.manageKeyInfo.archiveResource(id, convId, turnNum),
  };
}

// eslint-disable-next-line max-lines-per-function -- F20260813mren 加 docs.sync 后超 60 行；Composition Root 集中装配，拆分降低可读性
export function buildOtterToolClient(
  uc: UseCases,
  deps?: {
    /** F20260813mren 审视二轮：文档同步（sync_docs 工具）。由 app.ts 装配时注入。 */
    syncDocs?: (rootDir?: string) => Promise<{ synced: number; updated: number; skipped: number; archived: number; errors: number }>;
  },
): OtterToolClient {
  // 审视三轮：sync_docs 并发互斥标志（模块级——client 单例，全进程共享）
  let syncInFlight = false;
  return {
    conversation: {
      message: buildMessageClient(uc),
      participant: {
        join: async (convId, otterId) => {
          const otter = await uc.queryOtter.getById(otterId);
          const name = otter?.name ?? otterId;
          const { participant, systemMessage } = await uc.manageParticipant.join(
            convId, otterId, `${name} 加入了对话`,
          );
          // F20260910ctlv：进场 system entry 投影透出（create_otter 广播 entry.system SSE 用；
          // 旧降级路径返回 Message，无投影）
          if (systemMessage && "entryType" in systemMessage) {
            return { ...participant, systemEntry: { id: systemMessage.id, body: systemMessage.body, sequenceNum: systemMessage.sequenceNum } };
          }
          return participant;
        },
        getActive: async (convId) => {
          const participantsWithOtter = await uc.manageParticipant.getActiveParticipants(convId);
          // #446: modelAlias 在 usecase 批量预取，此处从 ParticipantWithOtter 透传
          return participantsWithOtter.map(p => ({ ...p.participant, otterName: p.otterName, ...(p.modelAlias !== undefined && { modelAlias: p.modelAlias }) }));
        },
        leave: (convId, otterId) => uc.manageParticipant.markLeft(convId, otterId),
      },
      // F20260910ctlv：entry 和 invoke 子命名空间（新模型，渐进迁移）
      // 旧路径继续工作，新路径优先，失败时 fallback 到旧路径
      entry: {
        createSpeakEntry: async (params) => {
          // 创建 speak 条目（新模型）
          const entry = await uc.sendEntry.createSpeakEntry({
            conversationId: params.conversationId,
            invokeId: params.invokeId,
            otterId: params.otterId,
            turnId: params.turnId,
            body: params.body,
          });
          return { id: entry.entry.id, entryType: entry.entry.entryType, body: entry.entry.body ?? '' };
        },
        createYieldEntry: async (params) => {
          // 创建 yield 条目 + invoke_end 条目 + 更新 invoke 记录
          const result = await uc.sendEntry.createYieldEntry({
            conversationId: params.conversationId,
            invokeId: params.invokeId,
            otterId: params.otterId,
            turnId: params.turnId,
            yieldTargets: params.yieldTargets,
          });
          return {
            yieldEntry: { id: result.yieldEntry.id, entryType: result.yieldEntry.entryType, yieldTargets: result.yieldEntry.yieldTargets ?? [] },
            invokeEndEntry: { id: result.invokeEndEntry.id, entryType: result.invokeEndEntry.entryType },
            invoke: {
              id: result.invoke.id,
              status: result.invoke.status,
              endedAt: result.invoke.endedAt,
              toolCallCount: result.invoke.toolCallCount,
              tokenUsageInput: result.invoke.tokenUsageInput,
              tokenUsageOutput: result.invoke.tokenUsageOutput,
            },
          };
        },
        getEntries: async (convId, opts) => {
          const entries = await uc.sendEntry.getEntries(convId, opts);
          // F20260910ctlv 批3：投影带 createdAt/senderId（自重启用户介入检测等只读消费）
          return entries.map(e => ({ id: e.id, entryType: e.entryType, body: e.body, senderId: e.senderId, senderType: e.senderType, createdAt: e.createdAt }));
        },
        // F20260910ctlv 批3：全文搜索（entries_fts，search_messages 工具数据源切换）
        searchEntries: async (convId: string, query: string, limit?: number) => {
          const entries = await uc.sendEntry.searchEntries(convId, query, limit);
          return entries.map(e => ({ id: e.id, entryType: e.entryType, senderId: e.senderId, senderType: e.senderType, body: e.body, sequenceNum: e.sequenceNum, createdAt: e.createdAt }));
        },
      },
      invoke: {
        appendInvokeEvent: async (invokeId, eventType, payload) => {
          await uc.sendEntry.appendInvokeEvent(invokeId, eventType as "assistant_text" | "assistant_toolcall" | "tool_result" | "error" | "speak", payload);
        },
        getInvokeById: async (invokeId) => {
          const invoke = await uc.sendEntry.getInvokeById(invokeId);
          if (!invoke) return null;
          return { id: invoke.id, status: invoke.status, toolCallCount: invoke.toolCallCount };
        },
        incrementToolCallCount: async (invokeId) => {
          await uc.sendEntry.incrementInvokeToolCallCount(invokeId);
        },
      },
      getActiveTurnNumber: (convId) => uc.manageConversation.getActiveTurnNumber(convId),
    },
    memory: buildMemoryClient(uc),
    terminology: {
      search: async (query: string, limit?: number) => {
        const results = await uc.manageTerminology.search(query, limit ?? 10);
        return results.map(e => ({
          id: e.id, term: e.term, definition: e.definition,
          aliases: e.aliases, category: e.category, context: e.context,
        }));
      },
      addTerm: async (params: { term: string; definition: string; aliases?: string[]; category?: string; context?: string }) => {
        const entry = await uc.manageTerminology.addTerm(params);
        return { id: entry.id, term: entry.term };
      },
    },
    otter: {
      create: (params) => uc.createOtter.execute(params),
      dissolve: (id) => uc.dissolveOtter.execute(id),
      getById: (id) => uc.queryOtter.getById(id),
      getActiveSession: (otterId) => uc.manageSession.getActiveSession(otterId),
      restart: (otterId, summary, modelAlias) => uc.manageSession.restartSession(otterId, summary, modelAlias),
    },
    context: {
      get: (otterId, key) => uc.manageContext.get(otterId, key),
      set: (otterId, key, value) => uc.manageContext.set(otterId, key, value),
      delete: (otterId, key) => uc.manageContext.delete(otterId, key),
    },
    resource: buildResourceClient(uc),
    // F20260813mren 审视二轮：sync_docs 工具——写文档后立即入库，不等重启
    docs: {
      sync: async (rootDir?: string) => {
        if (!deps?.syncDocs) {
          throw new Error("syncDocs not wired");
        }
        // 审视三轮 A-10 附带：并发互斥——并发调用直接返回进行中，防 file_path UNIQUE 伪错误
        if (syncInFlight) {
          throw new Error("文档同步进行中，请稍后重试");
        }
        syncInFlight = true;
        try {
          return await deps.syncDocs(rootDir);
        } finally {
          syncInFlight = false;
        }
      },
    },
    // F20260821i336：派工台账工具
    dispatch: {
      createRecord: async (params) => {
        const id = `dispatch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        // 使用 manageContext 存储派工记录（简化实现，避免新增 DB 表）
        const key = `dispatch:${id}`;
        const value = JSON.stringify({
          id,
          conversationId: params.conversationId,
          otterId: params.otterId,
          otterName: params.otterName,
          task: params.task,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
        await uc.manageContext.set(params.otterId, key, value);
        return { id };
      },
      updateRecord: async (params) => {
        // 查询所有 dispatch 记录，找到匹配的并更新
        const context = await uc.manageContext.get(params.otterId);
        for (const [key, value] of Object.entries(context)) {
          if (key.startsWith('dispatch:') && typeof value === 'string') {
            try {
              const record = JSON.parse(value);
              if (record.conversationId === params.conversationId && record.status !== 'completed' && record.status !== 'failed') {
                const now = new Date().toISOString();
                const updated = {
                  ...record,
                  status: params.status,
                  updatedAt: now,
                  completedAt: params.status === 'completed' || params.status === 'failed' ? now : undefined,
                  resultPr: params.resultPr,
                  resultSummary: params.resultSummary,
                };
                await uc.manageContext.set(params.otterId, key, JSON.stringify(updated));
              }
            } catch {
              // 解析失败，跳过
            }
          }
        }
      },
      queryRecords: async (params) => {
        // 查询所有 otter 的 dispatch 记录
        // 从 manageContext 获取所有 otter 的 context，筛选 dispatch 记录
        const records: Array<{
          id: string; conversationId: string; otterId: string; otterName: string; task: string;
          status: 'pending' | 'in_progress' | 'completed' | 'failed';
          createdAt: string; updatedAt: string; completedAt?: string; resultPr?: string; resultSummary?: string;
        }> = [];
        
        // 获取所有活跃参与者
        const participants = await uc.manageParticipant.getActiveParticipants(params.conversationId);
        
        // 遍历所有参与者，提取 dispatch 记录
        const extractRecords = async (otterId: string) => {
          try {
            const context = await uc.manageContext.get(otterId);
            for (const [key, value] of Object.entries(context)) {
              if (!key.startsWith('dispatch:') || typeof value !== 'string') continue;
              try {
                const record = JSON.parse(value);
                // 过滤条件
                if (params.status && record.status !== params.status) continue;
                if (params.otterId && record.otterId !== params.otterId) continue;
                records.push(record);
              } catch {
                // 解析失败，跳过
              }
            }
          } catch {
            // 获取 context 失败，跳过该 otter
          }
        };
        
        await Promise.all(participants.map(p => extractRecords(p.participant.otterId)));
        
        // 按创建时间倒序排序
        return records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      },
    },
  };
}
