import type { TerminologyEntry, TerminologyStatus } from "@entities/memory/terminology-entry";
import type { TerminologyRepository } from "./terminology-repository";

export interface AddTermInput {
  term: string;
  definition: string;
  aliases?: string[];
  category?: string;
  context?: string;
  examples?: string[];
}

export interface UpdateTermInput {
  definition?: string;
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

  async updateTerm(id: string, changes: UpdateTermInput): Promise<TerminologyEntry> {
    const existing = await this.repo.getById(id);
    if (!existing) {
      throw new Error(`Terminology entry not found: ${id}`);
    }
    if (existing.status === "deprecated") {
      throw new Error(`Cannot update deprecated terminology entry: ${id}`);
    }
    const updated: TerminologyEntry = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
      version: existing.version + 1,
    };
    await this.repo.update(updated);
    return updated;
  }

  async deprecateTerm(id: string): Promise<void> {
    const existing = await this.repo.getById(id);
    if (!existing) {
      throw new Error(`Terminology entry not found: ${id}`);
    }
    if (existing.status === "deprecated") {
      return;
    }
    const updated: TerminologyEntry = {
      ...existing,
      status: "deprecated" as TerminologyStatus,
      updatedAt: new Date().toISOString(),
      version: existing.version + 1,
    };
    await this.repo.update(updated);
  }

  async search(query: string, limit: number): Promise<TerminologyEntry[]> {
    return this.repo.search(query, limit);
  }

  async getById(id: string): Promise<TerminologyEntry | null> {
    return this.repo.getById(id);
  }
}
