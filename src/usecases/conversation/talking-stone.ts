/**
 * Talking Stone 路由校验（纯函数）
 *
 * Why: 从 tool-factory.ts 下沉发言石路由校验逻辑，实现领域规则与工具实现分离。
 * talking-stone.ts 包含纯函数，无状态依赖。
 *
 * 设计依据：R20260817arnt Q2 tool-factory 领域规则下沉
 */

/**
 * F20260803trrf: name->id resolve（NFC 归一化），speak 改用名字，系统侧做映射
 *
 * @param recipients 接收者名字列表（Otter 名字或 'user'）
 * @param active 当前活跃参与者列表
 * @returns resolvedIds: 解析后的 ID 列表，invalid: 无法解析的名字列表
 */
export function resolveTalkingStoneTargets(
  recipients: string[],
  active: Array<{ otterId: string; otterName: string }>,
): { resolvedIds: string[]; invalid: string[] } {
  const byName = new Map<string, string>();
  for (const p of active) byName.set(p.otterName.normalize("NFC"), p.otterId);
  /** 用 Set 去重，防止 LLM 传重复名字导致 DB 存重复 otterId（F20260803trrf review P3） */
  const resolvedSet = new Set<string>();
  const invalid: string[] = [];
  for (const r of recipients) {
    if (r === "user") { resolvedSet.add("user"); continue; }
    const id = byName.get(r.normalize("NFC"));
    if (id) resolvedSet.add(id); else invalid.push(r);
  }
  return { resolvedIds: [...resolvedSet], invalid };
}

/**
 * F20260803trrf: 校验 + resolve，降低 execute 复杂度
 *
 * @param recipients 接收者名字列表
 * @param active 当前活跃参与者列表
 * @param selfOtterId 当前 Otter 的 ID（不能传给自己）
 * @returns resolvedIds: 解析后的 ID 列表，error: 错误信息（如果有）
 */
export function validateAndResolve(
  recipients: string[],
  active: Array<{ otterId: string; otterName: string }>,
  selfOtterId: string,
): { resolvedIds: string[]; error?: string } {
  if (!recipients || recipients.length === 0) return { resolvedIds: [], error: "[错误] 行动权目标不能为空数组。请指定下一个应该行动的参与者名字。" };
  const { resolvedIds, invalid } = resolveTalkingStoneTargets(recipients, active);
  if (resolvedIds.includes(selfOtterId)) {
    const myName = active.find(p => p.otterId === selfOtterId)?.otterName ?? selfOtterId;
    return { resolvedIds: [], error: `[错误] 不能把行动权传给自己（${myName}）。请选择其他参与者。` };
  }
  if (invalid.length > 0) {
    const options = [...active.map(p => p.otterName), "搭档('user')"].join("、");
    return { resolvedIds: [], error: `[错误] 行动权目标不在场：${invalid.join("、")}。可选目标：${options}。请用正确的名字重新调用 yield。` };
  }
  return { resolvedIds };
}
