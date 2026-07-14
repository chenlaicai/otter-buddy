/**
 * 工厂函数：注入 db + agentRegistry，返回 OtterPort。
 *
 * 使用方式：
 *   const otterPort = initOtter({ db, agentRegistry });
 */

import type Database from "better-sqlite3";
import type { OtterPort } from "../port";
import { OtterRepository } from "./repository";
import { OtterAdapter, type AgentLifecyclePort } from "./adapter";

export function initOtter({
  db,
  agentRegistry,
}: {
  db: Database.Database;
  agentRegistry: AgentLifecyclePort;
}): OtterPort {
  const repository = new OtterRepository(db);
  const adapter = new OtterAdapter(repository, agentRegistry);
  return adapter;
}
