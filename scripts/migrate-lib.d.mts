/** 迁移工具共享库类型声明（migrate-lib.mjs 的测试/消费方类型面） */

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface MigrateManifest {
  version: number;
  createdAt: string;
  sourceRoot: string;
  files: ManifestFile[];
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

export declare const MIGRATE_INCLUDES: string[];
export declare function collectMigrateFiles(dataDir: string): string[];
export declare function sha256File(absPath: string): string;
export declare function sqliteTableCounts(dbPath: string): Record<string, number>;
export declare function sqliteBackup(srcDbPath: string, destDbPath: string): Promise<void>;
export declare function buildManifest(
  dataDir: string,
  relFiles: string[],
  sourceRoot: string,
): Promise<MigrateManifest>;
export declare function verifyAgainstManifest(
  dataDir: string,
  manifest: MigrateManifest,
): { ok: boolean; report: VerifyReport };
export declare function fastCopyDir(src: string, dest: string): void;
