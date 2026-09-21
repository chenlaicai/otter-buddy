/** Otter 类型 */
/** F20260820a4rt: 从联合类型改为 string，运行时校验交由 manifest loader + lint 处理 */
export type OtterType = string;

/** Otter 状态 */
export type OtterStatus = "active" | "dissolved";

/** Otter 角色值对象 */
export interface OtterRole {
  name: string;
  responsibilities: string[];
}

/** Otter 实体 */
export interface Otter {
  id: string;
  name: string;
  type: OtterType;
  status: OtterStatus;
  /** F20260921otcl：出生颜色（色板 key，如 'teal'）。大獭与未回填存量为 null；
   *  值域见 api-contract OTTER_PALETTE_KEYS（消费方经投影透传，前端最终消费） */
  color: string | null;
  role: OtterRole | null;
  parentOtterId: string | null;
  createdAt: string;
  dissolvedAt: string | null;
}

/**
 * 是否可以解散 Otter。
 * 仅 active 状态的 Otter 可被解散。
 * 来源：新增补强，旧 adapter dissolve() 隐含前置条件
 */
export function canDissolveOtter(status: OtterStatus): boolean {
  return status === "active";
}
