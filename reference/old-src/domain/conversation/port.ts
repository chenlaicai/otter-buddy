/**
 * ConversationPort：domain/conversation 唯一的公开接口。
 *
 * 方法行为参见 F20260713c7p2 设计文档。
 * 跨模块事务（sendMessage + memory 索引等）由 app/orchestration 编排，本模块仅负责自身数据写入。
 */

import type {
  CompleteMessageInput,
  Conversation,
  ConversationTreeNode,
  KeyFact,
  KeyFactInput,
  KeyInfo,
  LinkedResource,
  LinkedResourceInput,
  Message,
  MessageEvent,
  MessageEventInput,
  MessageInput,
  MessageStatus,
  StartMessageInput,
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

  // --- Messages (two-layer model: body + streaming events) ---

  /**
   * 发送用户消息（立即完成）。
   * 创建 status='completed', body=message.body 的消息。
   * 用于 user 消息--无 streaming 阶段。
   */
  sendMessage(conversationId: string, message: MessageInput): Promise<Message>;

  /**
   * 开始 Otter 消息（进入 streaming 状态）。
   * 创建 status='streaming', body=NULL 的消息。
   * 调用方（app/agent-runtime）随后通过 appendEvent 追加流式事件，
   * 最终通过 completeMessage 设置最终 body。
   */
  startMessage(
    conversationId: string,
    sender: StartMessageInput,
  ): Promise<Message>;

  /**
   * 追加流式事件到 streaming 消息。
   * 事件 append-only（INSERT only）。
   * sequence_num per-message 自增。
   * 仅当 message.status='streaming' 时允许追加。
   */
  appendEvent(
    messageId: string,
    event: MessageEventInput,
  ): Promise<MessageEvent>;

  /**
   * 完成消息--设置最终 body（类似 Snail Shell 的 set_final_body）。
   * status: streaming -> completed
   * body 设置为传入文本，completed_at 记录时间。
   * 不可逆。调用后消息即为最终状态。
   */
  completeMessage(
    messageId: string,
    completion: CompleteMessageInput,
  ): Promise<Message>;

  /**
   * 标记消息失败。
   * status: streaming -> failed
   * completed_at 记录时间。body 保持 NULL。
   * 已有的流式事件保留（用于调试）。
   */
  failMessage(messageId: string): Promise<Message>;

  /** 按 ID 获取消息 */
  getMessageById(id: string): Promise<Message | null>;

  /**
   * 获取消息列表（分页，按 sequence_num 倒序，默认 limit=50）。
   * 默认返回所有状态的消息（含 streaming、failed）。
   * 可通过 status 参数过滤。
   */
  getMessages(
    conversationId: string,
    opts?: { limit?: number; before?: string; status?: MessageStatus },
  ): Promise<Message[]>;

  /**
   * 获取消息的流式事件列表（按 sequence_num ASC）。
   * 对应 Snail Shell 中"折叠的流式内容"--此处为展开查询。
   */
  getMessageEvents(messageId: string): Promise<MessageEvent[]>;

  /**
   * 获取消息上下文（前/后/双向，按 sequence_num）。
   * 包含所有状态的消息。
   */
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
