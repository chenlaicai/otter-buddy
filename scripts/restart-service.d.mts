/**
 * F20260930rsab: restart-service.mjs（#1069 --add 兜底正道）的类型声明。
 * Why: TypeScript strict 模式下 .mjs 需要声明文件才能消除 TS7016（lint-date-bombs.d.mts 先例）。
 */

/** 白名单条目（.otter/allowed-service-ports.json services 数组元素） */
export interface ServicePortEntry {
  port: number;
  projectDir: string;
}

/** resolvePortEntry 入参（普通对象；文件 IO 限定 whitelistPath 一个文件） */
export interface ResolvePortEntryInput {
  port: number;
  projectDir: string | null;
  add: boolean;
  whitelistPath: string;
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
