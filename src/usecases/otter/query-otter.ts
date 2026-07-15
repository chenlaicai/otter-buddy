import type { Otter } from "@entities/otter/otter";
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
      throw new Error("Big Otter not found");
    }
    return otter;
  }
}
