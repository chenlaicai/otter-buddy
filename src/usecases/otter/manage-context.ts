import type { OtterContextRepository } from "./otter-context-repository";
import { redactSecrets } from "@usecases/security/redact-secrets";

/** 管理 Otter 上下文（get_context / set_context 工具的 use case） */
export class ManageContext {
  constructor(private readonly repo: OtterContextRepository) {}

  async get(otterId: string, key?: string): Promise<Record<string, string>> {
    return this.repo.get(otterId, key);
  }

  /**
   * F20260821scrt: otter_context 是 LLM 可写的自由 TEXT KV，
   * value 写入前脱敏。系统内部状态（如 embedding_degraded）直写
   * repository，不经此 usecase，天然不受影响。
   */
  async set(otterId: string, key: string, value: string): Promise<void> {
    await this.repo.set(otterId, key, redactSecrets(value));
  }

  async delete(otterId: string, key: string): Promise<void> {
    await this.repo.delete(otterId, key);
  }
}
