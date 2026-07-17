import type { TerminologyEntry } from "@entities/memory/terminology-entry";
import type { TerminologyRepository } from "./terminology-repository";

export interface AddTermInput {
  term: string;
  definition: string;
  aliases?: string[];
  category?: string;
  context?: string;
  examples?: string[];
}

export class ManageTerminology {
  constructor(private readonly repo: TerminologyRepository) {}

  async addTerm(input: AddTermInput): Promise<TerminologyEntry> {
    const now = new Date().toISOString();
    const entry: TerminologyEntry = {
      id: crypto.randomUUID(),
      term: input.term,
      aliases: input.aliases ?? [],
      definition: input.definition,
      context: input.context ?? null,
      examples: input.examples ?? null,
      category: input.category ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await this.repo.add(entry);
    return entry;
  }

  async search(query: string, limit: number): Promise<TerminologyEntry[]> {
    return this.repo.search(query, limit);
  }
}
