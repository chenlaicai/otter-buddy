/**
 * ConversationPort：domain/conversation 唯一的公开接口。
 *
 * 方法行为参见 F20260713c7p2 设计文档。
 * 跨模块事务（sendMessage + memory 索引等）由 app/orchestration 编排，本模块仅负责自身数据写入。
 */

import type {
  Conversation,
  ConversationTreeNode,
  KeyFact,
  KeyFactInput,
  KeyInfo,
  LinkedResource,
  LinkedResourceInput,
  Message,
  MessageInput,
} from "./model";

export interface ConversationPort {
  // --- Conversation CRUD ---

  /** 创建对话（root 或 child）。otterIds 写入 conversation_otters */
  create(params: {
    title: string;
    parentId?: string;
    otterIds: string[];
  }): Promise<Conversation>;

  /** 按 ID 查询对话 */
  getById(id: string): Promise<Conversation | null>;

  /** 完成对话（status: active -> completed） */
  complete(id: string): Promise<void>;

  /** 归档对话（status: completed -> archived） */
  archive(id: string): Promise<void>;

  // --- Tree ---

  /** 获取对话树（从 root 递归构建） */
  getTree(rootId: string): Promise<ConversationTreeNode>;

  /** 创建子对话。继承父对话的 otterIds */
  createChild(parentId: string, title: string): Promise<Conversation>;

  // --- Messages (append-only) ---

  /** 发送消息（INSERT only）。返回含 ID/sequenceNum/timestamp 的 Message */
  sendMessage(conversationId: string, message: MessageInput): Promise<Message>;

  /** 获取消息列表（分页，按 sequence_num 倒序，默认 limit=50） */
  getMessages(
    conversationId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<Message[]>;

  /** 获取消息上下文（前/后/双向） */
  expandMessage(
    messageId: string,
    direction: "before" | "after" | "both",
    count: number,
  ): Promise<Message[]>;

  // --- Key Info ---

  /** 添加关键事实。仅写 key_facts 表，memory 索引由 app/orchestration 编排 */
  addKeyFact(conversationId: string, fact: KeyFactInput): Promise<KeyFact>;

  /** 链接资源。仅写 linked_resources 表，external_resources + memory 索引由 app/orchestration 编排 */
  linkResource(
    conversationId: string,
    resource: LinkedResourceInput,
  ): Promise<LinkedResource>;

  /** 获取对话关键信息（KeyFacts + LinkedResources） */
  getKeyInfo(conversationId: string): Promise<KeyInfo>;

  /** 获取对话链接资源列表 */
  getLinkedResources(conversationId: string): Promise<LinkedResource[]>;
}
