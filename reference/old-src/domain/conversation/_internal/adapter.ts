/**
 * 业务逻辑适配器：实现 ConversationPort，编排对话生命周期 + 消息 + 对话树 + 关键信息。
 *
 * 设计要点：
 * - create: crypto.randomUUID() 生成 ID，计算 treePath，事务写入
 * - createChild: 独立事务（含读 parent + 读 otterIds + INSERT child + INSERT conversation_otters + UPDATE parent.updated_at）
 * - complete/archive: 状态校验 + 更新（含 updated_at）
 * - sendMessage: 用户消息，立即 completed，返回值从 DB 读取
 * - startMessage/appendEvent/completeMessage/failMessage: Otter 消息流式生命周期
 * - addKeyFact/linkResource: 仅写自身表，memory 索引由 app/orchestration 编排
 * - getTree: LIKE 查询 + 内存递归构建
 */

import type { ConversationPort } from "../port";
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
} from "../model";
import type { ConversationRepository } from "./repository";

export class ConversationAdapter implements ConversationPort {
  constructor(private readonly repo: ConversationRepository) {}

  async create(params: {
    title: string;
    parentId?: string;
    otterIds: string[];
  }): Promise<Conversation> {
    const id = crypto.randomUUID();

    let treePath: string;
    let parentId: string | null;

    if (params.parentId) {
      const parent = this.repo.getById(params.parentId);
      if (!parent) {
        throw new Error(`Parent conversation ${params.parentId} not found`);
      }
      treePath = `${parent.treePath}${id}/`;
      parentId = params.parentId;
    } else {
      treePath = `/${id}/`;
      parentId = null;
    }

    this.repo.create(id, {
      title: params.title,
      parentId,
      treePath,
      otterIds: params.otterIds,
    });

    return this.repo.getById(id)!;
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.repo.getById(id);
  }

  async complete(id: string): Promise<void> {
    const conv = this.repo.getById(id);
    if (!conv) {
      throw new Error(`Conversation not found: ${id}`);
    }
    if (conv.status !== "active") {
      throw new Error(
        `Cannot complete conversation with status: ${conv.status}`,
      );
    }
    this.repo.updateStatus(id, "completed");
  }

  async archive(id: string): Promise<void> {
    const conv = this.repo.getById(id);
    if (!conv) {
      throw new Error(`Conversation not found: ${id}`);
    }
    if (conv.status !== "completed") {
      throw new Error(
        `Cannot archive conversation with status: ${conv.status}`,
      );
    }
    this.repo.updateStatus(id, "archived");
  }

  async getTree(rootId: string): Promise<ConversationTreeNode> {
    const root = this.repo.getById(rootId);
    if (!root) {
      throw new Error(`Conversation not found: ${rootId}`);
    }

    const allNodes = this.repo.getByTreePathPrefix(`${root.treePath}%`);
    /** 构建 parentId -> children 映射 */
    const childrenMap = new Map<string, Conversation[]>();
    for (const node of allNodes) {
      if (node.id === rootId) continue;
      const siblings = childrenMap.get(node.parentId!) ?? [];
      siblings.push(node);
      childrenMap.set(node.parentId!, siblings);
    }

    const buildTree = (conv: Conversation): ConversationTreeNode => ({
      conversation: conv,
      children: (childrenMap.get(conv.id) ?? []).map(buildTree),
    });

    return buildTree(root);
  }

  async createChild(parentId: string, title: string): Promise<Conversation> {
    const id = crypto.randomUUID();
    return this.repo.createChild(parentId, id, title);
  }

  async sendMessage(
    conversationId: string,
    message: MessageInput,
  ): Promise<Message> {
    const id = crypto.randomUUID();
    const sequenceNum = this.repo.getMaxSequenceNum(conversationId) + 1;
    return this.repo.createCompletedMessage(id, conversationId, message, sequenceNum);
  }

  async startMessage(
    conversationId: string,
    sender: StartMessageInput,
  ): Promise<Message> {
    const id = crypto.randomUUID();
    const sequenceNum = this.repo.getMaxSequenceNum(conversationId) + 1;
    return this.repo.createStreamingMessage(id, conversationId, sender, sequenceNum);
  }

  async appendEvent(
    messageId: string,
    event: MessageEventInput,
  ): Promise<MessageEvent> {
    const message = this.repo.getMessageById(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }
    if (message.status !== "streaming") {
      throw new Error(
        `Cannot append event to message with status: ${message.status}`,
      );
    }
    const id = crypto.randomUUID();
    const sequenceNum = this.repo.getMaxEventSequenceNum(messageId) + 1;
    return this.repo.appendEvent(id, messageId, event, sequenceNum);
  }

  async completeMessage(
    messageId: string,
    completion: CompleteMessageInput,
  ): Promise<Message> {
    const message = this.repo.getMessageById(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }
    if (message.status !== "streaming") {
      throw new Error(
        `Cannot complete message with status: ${message.status}`,
      );
    }
    /** body 非空字符串校验（设计硬约束） */
    if (!completion.body) {
      throw new Error("body must be non-empty string");
    }
    /** attachments 缺省时保留 startMessage 时的预置（架构师-2 #1） */
    const attachments = completion.attachments !== undefined
      ? completion.attachments
      : message.attachments;
    return this.repo.completeMessage(messageId, completion.body, attachments);
  }

  async failMessage(messageId: string): Promise<Message> {
    const message = this.repo.getMessageById(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }
    if (message.status !== "streaming") {
      throw new Error(
        `Cannot fail message with status: ${message.status}`,
      );
    }
    return this.repo.failMessage(messageId);
  }

  async getMessageById(id: string): Promise<Message | null> {
    return this.repo.getMessageById(id);
  }

  async getMessages(
    conversationId: string,
    opts?: { limit?: number; before?: string; status?: MessageStatus },
  ): Promise<Message[]> {
    return this.repo.getMessages(conversationId, opts);
  }

  async getMessageEvents(messageId: string): Promise<MessageEvent[]> {
    return this.repo.getMessageEvents(messageId);
  }

  async expandMessage(
    messageId: string,
    direction: "before" | "after" | "both",
    count: number,
  ): Promise<Message[]> {
    const target = this.repo.getMessageById(messageId);
    if (!target) {
      throw new Error(`Message not found: ${messageId}`);
    }

    if (direction === "before") {
      return this.repo.getMessagesBefore(
        target.conversationId,
        messageId,
        count,
      );
    }

    if (direction === "after") {
      return this.repo.getMessagesAfter(
        target.conversationId,
        messageId,
        count,
      );
    }

    /** both: 先查 before 和 after，合并后按 sequence_num ASC 排序（架构师-2 G2） */
    const before = this.repo.getMessagesBefore(
      target.conversationId,
      messageId,
      count,
    );
    const after = this.repo.getMessagesAfter(
      target.conversationId,
      messageId,
      count,
    );
    return [...before, target, ...after].sort(
      (a, b) => a.sequenceNum - b.sequenceNum,
    );
  }

  async addKeyFact(
    conversationId: string,
    fact: KeyFactInput,
  ): Promise<KeyFact> {
    const id = crypto.randomUUID();
    return this.repo.addKeyFact(id, conversationId, fact);
  }

  async linkResource(
    conversationId: string,
    resource: LinkedResourceInput,
  ): Promise<LinkedResource> {
    const id = crypto.randomUUID();
    return this.repo.linkResource(id, conversationId, resource);
  }

  async getKeyInfo(conversationId: string): Promise<KeyInfo> {
    return {
      keyFacts: this.repo.getKeyFacts(conversationId),
      linkedResources: this.repo.getLinkedResources(conversationId),
    };
  }

  async getLinkedResources(conversationId: string): Promise<LinkedResource[]> {
    return this.repo.getLinkedResources(conversationId);
  }
}
