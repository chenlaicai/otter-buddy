import type {
  TerminologyEntry,
  TerminologyStatus,
} from "@entities/memory/terminology-entry";

export interface TerminologyEntryRow {
  id: string;
  term: string;
  aliases: string;
  aliases_flat: string;
  definition: string;
  context: string | null;
  examples: string | null;
  category: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export function rowToTerminologyEntry(row: TerminologyEntryRow): TerminologyEntry {
  return {
    id: row.id,
    term: row.term,
    aliases: JSON.parse(row.aliases) as string[],
    definition: row.definition,
    context: row.context,
    examples: row.examples ? (JSON.parse(row.examples) as string[]) : null,
    category: row.category,
    status: row.status as TerminologyStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function entryToRow(entry: TerminologyEntry): TerminologyEntryRow {
  return {
    id: entry.id,
    term: entry.term,
    aliases: JSON.stringify(entry.aliases),
    aliases_flat: entry.aliases.join(" "),
    definition: entry.definition,
    context: entry.context,
    examples: entry.examples ? JSON.stringify(entry.examples) : null,
    category: entry.category,
    status: entry.status,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    version: entry.version,
  };
}
