/** 迁移工具共享库类型声明（migrate-lib.mjs 的测试/消费方类型面） */

export interface ManifestFile {
  path: string;
  type: "file";
  size: number;
  sha256: string;
}

export interface ManifestSymlink {
  path: string;
  type: "symlink";
  target: string;
}

export type ManifestEntry = ManifestFile | ManifestSymlink;

export interface MigrateManifest {
  version: number;
  createdAt: string;
  sourceRoot: string;
  files: ManifestEntry[];
  databases: Record<string, { tables: Record<string, number> }>;
  options: { includes: string[] };
  assumedConsistent?: boolean;
}

export interface VerifyReport {
  verifiedAt: string;
  filesChecked: number;
  dbsChecked: number;
  fileDiffs: string[];
  tableDiffs: string[];
}

export interface MigrateEntry {
  rel: string;
  type: "file" | "symlink";
}

export declare const MIGRATE_INCLUDES: string[];
export declare function collectMigrateEntries(dataDir: string): MigrateEntry[];
export declare function collectMigrateFiles(dataDir: string): string[];
export declare function isSqliteFile(relPath: string): boolean;
export declare function sha256File(absPath: string): string;
export declare function sqliteTableCounts(dbPath: string): Record<string, number>;
export declare function sqliteBackup(srcDbPath: string, destDbPath: string): Promise<void>;
export declare function buildManifest(
  dataDir: string,
  entries: MigrateEntry[],
  sourceRoot: string,
): Promise<MigrateManifest>;
export declare function verifyAgainstManifest(
  dataDir: string,
  manifest: MigrateManifest,
): { ok: boolean; report: VerifyReport };
export declare function fastCopyDir(src: string, dest: string): void;
export declare function manifestPayloadBytes(manifest: MigrateManifest): number;
export declare function volumeFreeBytes(dirPath: string): number | null;
