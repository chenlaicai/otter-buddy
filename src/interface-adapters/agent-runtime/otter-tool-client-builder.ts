import type { OtterToolClient } from "./otter-tool-client";
import type { UseCases } from "../../main";

/** 构建 OtterToolClient 的 conversation.message 部分 */
function buildMessageClient(uc: UseCases) {
  return {
    startSpeaking: (messageId: string, params: { body: string; talkingStonePassedTo: string[] }) =>
      uc.sendMessage.startSpeaking(messageId, params),
    complete: (messageId: string, params?: { body?: string; talkingStonePassedTo?: string[] }) =>
      uc.sendMessage.complete(messageId, params),
    getById: (id: string) => uc.queryMessage.getMessageById(id),
    list: (convId: string, opts?: { limit?: number; before?: string }) =>
      uc.queryMessage.getMessages(convId, { limit: opts?.limit, before: opts?.before }),
    search: (convId: string, query: string, limit?: number) =>
      uc.queryMessage.searchMessages(convId, query, limit),
    getTurnHistory: (convId: string, opts?: { includeMessages?: boolean }) =>
      uc.queryMessage.getTurnHistory(convId, opts),
  };
}

/** 构建 OtterToolClient 的 memory 部分（渐进式披露：支持 detail_level、getById 和 getDetails） */
function buildMemoryClient(uc: UseCases) {
  return {
    getById: async (id: string) => {
      const entry = await uc.manageMemory.getById(id);
      if (!entry) return null;
      return { id: entry.id, content: entry.content, score: 1, layer: entry.layer };
    },
    search: async (query: string, limit?: number, detailLevel?: "summary" | "snippet" | "full", library?: string) => {
      const result = await uc.searchMemory.search({ query, limit: limit ?? 10, detailLevel, library });
      return result.entries.map(e => ({
        id: e.id,
        content: e.content,
        score: e.score,
        layer: e.layer,
        snippet: e.snippet,
        contentType: e.contentType,
        metadata: e.metadata ?? undefined,
        createdAt: e.createdAt,
      }));
    },
    /** 按 ID 批量获取完整记忆条目（渐进式披露 get_memory_detail） */
    getDetails: async (ids: string[]) => {
      const entries = await uc.manageMemory.getDetails(ids);
      return entries.map(e => ({
        id: e.id,
        content: e.content,
        layer: e.layer,
        contentType: e.contentType,
        metadata: e.metadata ?? undefined,
        createdAt: e.createdAt,
      }));
    },
  };
}

/**
 * 构建 OtterToolClient：包装所有 use case，作为工具访问 Otter 数据的统一门面。
 */
function buildResourceClient(uc: UseCases) {
  return {
    link: (params: { conversationId: string; url?: string; title?: string; content?: string; category?: string; linkedBy: string; resourceType?: string; groupId?: string }, turnNum?: number) =>
      uc.manageKeyInfo.linkResource({
        conversationId: params.conversationId,
        resourceType: params.resourceType ?? "url",
        url: params.url,
        title: params.title,
        content: params.content,
        category: params.category,
        linkedBy: params.linkedBy,
        autoLinked: false,
        groupId: params.groupId,
      }, turnNum),
    list: (convId: string, filters?: { status?: "active" | "superseded" | "archived"; resourceType?: string }) =>
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

export function buildOtterToolClient(uc: UseCases): OtterToolClient {
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
    },
    context: {
      get: (otterId, key) => uc.manageContext.get(otterId, key),
      set: (otterId, key, value) => uc.manageContext.set(otterId, key, value),
      delete: (otterId, key) => uc.manageContext.delete(otterId, key),
    },
    resource: buildResourceClient(uc),
  };
}
