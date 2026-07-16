import type { OtterContextRepository } from "./otter-context-repository";

/** 管理 Otter 上下文（get_context / set_context 工具的 use case） */
export class ManageContext {
  constructor(private readonly repo: OtterContextRepository) {}

  async get(otterId: string, key?: string): Promise<Record<string, string>> {
    return this.repo.get(otterId, key);
  }

  async set(otterId: string, key: string, value: string): Promise<void> {
    await this.repo.set(otterId, key, value);
  }
}
