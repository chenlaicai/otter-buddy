/**
 * F20260930rsab: restart-service.mjs（#1069 --add 兜底正道）的类型声明。
 * Why: TypeScript strict 模式下 .mjs 需要声明文件才能消除 TS7016（lint-date-bombs.d.mts 先例）。
 */

/** 白名单条目（.otter/allowed-service-ports.json services 数组元素） */
export interface ServicePortEntry {
  port: number;
  projectDir: string;
}

/** resolvePortEntry 入参（普通对象；文件 IO 限定 whitelistPath 一个文件；
 * allowedRoots 为 #1250 检视 S1 处置新增的 --add 授权边界：工作根数组） */
export interface ResolvePortEntryInput {
  port: number;
  projectDir: string | null;
  add: boolean;
  whitelistPath: string;
  allowedRoots?: string[];
}

/** 成功结果：entry + 解析后的声明目录；declared=true 表示本次 --add 写回了白名单 */
export interface ResolvePortEntryOk {
  ok: true;
  entry: ServicePortEntry;
  declaredDir: string;
  declared?: boolean;
}

/** 失败结果：error 为面向用户的拒绝理由（含正道指引） */
export interface ResolvePortEntryErr {
  ok: false;
  error: string;
}

export declare function resolvePortEntry(input: ResolvePortEntryInput): ResolvePortEntryOk | ResolvePortEntryErr;

/** F20261008hcpa（#1356 层2 疏通）：kill-by-pid 静态校验入参 */
export interface KillByPidCheckInput {
  pid: number;
  projectDir: string | null;
  mainPid: number | null;
  selfPid: number;
  selfPpid: number;
  allowedRoots: string[];
}

export declare function assertKillByPidSafe(input: KillByPidCheckInput): ResolvePortEntryOk | ResolvePortEntryErr;

/** #1580：kill-by-pid 合法根构造（otter 工作根 + alpha 规范数据根） */
export declare function killByPidAllowedRoots(otterRoot: string): string[];

/** F20261023ktru（#1069）：执行级使用痕迹——append-only JSONL（ts 自动补齐 + 业务字段，
 * action/outcome/pid/projectDir 等）。tracePath 缺省落 <otterRoot>/data/metrics/
 * restart-service-usage.jsonl（断言②「被使用 ≥1 次」的数据源），单测注入 tmp 路径。
 * 写失败静默不抛。 */
export declare function traceUsage(record: Record<string, unknown>, tracePath?: string): void;
