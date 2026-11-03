/** #1294: from 链检查纯函数类型声明（mjs 供测试 import） */
export interface BacklinkEntry {
  rel: string;
  id?: string;
  /** from 元素运行时可为非字符串（YAML map 形态的历史数据），函数内按元素级形态处理 */
  from?: unknown[];
  fromMalformed?: boolean;
}
export interface BrokenBacklink {
  rel: string;
  id?: string;
  danglingForward?: string;
  self?: string;
  malformed?: string;
}
export declare function findBrokenBacklinks(entries: BacklinkEntry[]): BrokenBacklink[];
export declare function computeReverseIndex(entries: BacklinkEntry[]): Map<string, string[]>;
export declare function findDuplicateIds(entries: Array<{ rel: string; id?: string }>): Map<string, string[]>;
export declare function evaluateDistFreshness(
  srcEntries: Array<{ rel: string; mtimeMs: number }>,
  distEntries: Array<{ rel: string; mtimeMs: number }>,
): { fresh: boolean; skipped?: boolean; newestSrc?: string };
