/**
 * 工厂函数：注入 db，返回 ConversationPort。
 *
 * 使用方式：
 *   const conversationPort = initConversation({ db });
 */

import type Database from "better-sqlite3";
import type { ConversationPort } from "../port";
import { ConversationRepository } from "./repository";
import { ConversationAdapter } from "./adapter";

export function initConversation({ db }: { db: Database.Database }): ConversationPort {
  const repository = new ConversationRepository(db);
  const adapter = new ConversationAdapter(repository);
  return adapter;
}
