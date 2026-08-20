/**
 * @提及解析工具函数（F20260820i333）
 *
 * 从文本中提取 @提及并匹配在场成员名册。
 * 支持多 @、无尾随空格、标点分隔、NFC 归一化。
 * 含目标校验与 feedback 构建逻辑。 */

/**
 * 从文本解析 @提及
 * @param text 消息文本
 * @param participants 当前在场参与者列表
 * @returns resolvedIds: 解析后的 ID 列表, invalidNames: 无法解析的名字列表
 */
export function parseMentionsFromText(
  text: string,
  participants: Array<{ otterId: string; otterName: string }>,
): { resolvedIds: string[]; invalidNames: string[] } {
  /** 匹配 @名字：名字 = 非空白且非中文标点的连续字符，后接空白/中文标点/字符串结尾 */
  const regex = /@([^\s，。！？、；：\u201c\u201d\u2018\u2019\uff08\uff09\u3010\u3011\u300a\u300b\u3000]+)(?=[\s，。！？、；：\u201c\u201d\u2018\u2019\uff08\uff09\u3010\u3011\u300a\u300b\u3000]|$)/g
  const mentionedNames: string[] = []
  let match
  while ((match = regex.exec(text)) !== null) {
    mentionedNames.push(match[1].normalize('NFC'))
  }

  if (mentionedNames.length === 0) {
    return { resolvedIds: [], invalidNames: [] }
  }

  /** 构建名字->ID 映射（NFC 归一化） */
  const byName = new Map<string, string>()
  for (const p of participants) {
    byName.set(p.otterName.normalize('NFC'), p.otterId)
  }

  const resolvedSet = new Set<string>()
  const invalidNames: string[] = []
  for (const name of mentionedNames) {
    const id = byName.get(name)
    if (id) {
      resolvedSet.add(id)
    } else {
      invalidNames.push(name)
    }
  }

  return { resolvedIds: [...resolvedSet], invalidNames }
}


