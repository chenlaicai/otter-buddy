import type { LocalOtter } from './mappers'

/**
 * 参与者列表逐字段浅比较（#502）。
 *
 * 轮询/事件回调每次 mapParticipantDTO 产出全新对象数组，即便内容一字未变，
 * setAllOtters 也会拿到新引用 → RightPanel 整树 re-render → hover 快览卡微闪。
 * LocalOtter 的展示字段全是原始值（role 只取 name），逐字段等值比较足够。
 *
 * 仅比较 UI 消费字段：id/name/type/createdAt/role.name/modelAlias。
 * parentOtterId 不进任何渲染路径（创建后不再展示），不参与比较。
 */
export function shallowEqualOtters(a: LocalOtter[], b: LocalOtter[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.type !== y.type ||
      x.createdAt !== y.createdAt ||
      x.role?.name !== y.role?.name ||
      x.modelAlias !== y.modelAlias
    ) {
      return false
    }
  }
  return true
}

/**
 * setAllOtters 专用 updater：内容未变时返回 prev（保引用，跳过 re-render）。
 * 用法：setAllOtters(prev => mergeOttersIfChanged(prev, convId, next))
 */
export function mergeOttersIfChanged(
  prev: Record<string, LocalOtter[]>,
  convId: string,
  next: LocalOtter[],
): Record<string, LocalOtter[]> {
  const current = prev[convId]
  if (current && shallowEqualOtters(current, next)) return prev
  return { ...prev, [convId]: next }
}
