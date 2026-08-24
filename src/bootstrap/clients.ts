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
  };
}

export function buildMemoryClient(uc: UseCases) {
  return {
    getById: async (id: string) => {
      const entry = await uc.manageMemory.getById(id);
      return entry ? { id: entry.id, content: entry.content, score: 1, layer: entry.layer } : null;
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
          const { participant } = await uc.manageParticipant.join(
            convId, otterId, `${name} 加入了对话`,
          );
          return participant;
        },
        getActive: async (convId) => {
          const participantsWithOtter = await uc.manageParticipant.getActiveParticipants(convId);
          return participantsWithOtter.map(p => ({ ...p.participant, otterName: p.otterName }));
        },
        leave: (convId, otterId) => uc.manageParticipant.markLeft(convId, otterId),
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
      restart: (otterId, summary) => uc.manageSession.restartSession(otterId, summary),
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
