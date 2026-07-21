import type { Otter } from "@entities/otter/otter";
import type { OtterRepository } from "./otter-repository";

export class QueryOtter {
  constructor(private readonly repo: OtterRepository) {}

  async getById(id: string): Promise<Otter | null> {
    return this.repo.getById(id);
  }
}
