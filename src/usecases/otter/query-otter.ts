import type { Otter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";
import type { OtterRepository } from "./otter-repository";

export class QueryOtter {
  constructor(private readonly repo: OtterRepository) {}

  async getById(id: string): Promise<Otter | null> {
    return this.repo.getById(id);
  }

  async getBigOtter(): Promise<Otter> {
    const otter = await this.repo.getBigOtter();
    if (!otter) {
      /** B2 回归守护：大獭必须存在（系统不变量） */
      throw new DomainError("Big Otter not found", "not_found");
    }
    return otter;
  }
}
