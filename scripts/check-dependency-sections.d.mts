/** check-dependency-sections 机械闸类型声明（.mjs 模块供 TS 测试 import，先例 check-pr-evidence.d.mts） */

/** npm 依赖分区名（互斥判定的枚举面）。 */
export declare const DEPENDENCY_SECTIONS: string[];

/** 依赖分区表：包名 → 版本范围。 */
export type DependencyTable = Record<string, string>;

/** 最小 package.json 视图（只声明本闸读到的字段）。 */
export interface PackageJsonLike {
  dependencies?: DependencyTable;
  devDependencies?: DependencyTable;
  optionalDependencies?: DependencyTable;
  peerDependencies?: DependencyTable;
}

/** 最小 package-lock.json 视图（packages 映射）。 */
export interface PackageLockLike {
  packages?: Record<string, { version?: string; dev?: boolean; devOptional?: boolean }>;
}

/** 分区重复声明违规。 */
export interface SectionDuplicate {
  name: string;
  sections: string[];
}

/** 运行时依赖被打 dev 标记的违规。 */
export interface DevFlaggedRuntimeDep {
  name: string;
  entry: string;
  version?: string;
}

/** 汇总结果。 */
export interface DependencySectionsResult {
  ok: boolean;
  duplicates: SectionDuplicate[];
  devFlagged: DevFlaggedRuntimeDep[];
}

export declare function findSectionDuplicates(pkg: PackageJsonLike): SectionDuplicate[];

export declare function findDevFlaggedRuntimeDeps(
  pkg: PackageJsonLike,
  lock: PackageLockLike,
): DevFlaggedRuntimeDep[];

export declare function checkDependencySections(
  pkg: PackageJsonLike,
  lock: PackageLockLike,
): DependencySectionsResult;

export declare function formatViolations(result: {
  duplicates: SectionDuplicate[];
  devFlagged: DevFlaggedRuntimeDep[];
}): string;
