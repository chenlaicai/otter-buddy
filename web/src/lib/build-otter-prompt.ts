/**
 * F20260826ucrt：创建小獭 UI 的 systemPrompt 引导生成模板。
 *
 * 纯函数（无 React 依赖），便于单测锁结构。
 * 定位：UI 弹窗「引导生成」档的骨架——与大獭召唤时精心编写的 prompt 无法同日而语，
 * 但替换掉 mock 时代的一句话玩具模板；「高级」开关兜底自由编辑。
 *
 * 结构（三段式，测试断言只锁结构不锁措辞）：
 *   1. 身份段：你是{name}，{角色名}。
 *   2. 职责段：每条职责一行
 *   3. 协作约定段：交棒/诚实/汇报格式
 */

export interface OtterPromptFormInput {
  /** 小獭名称（必填） */
  name: string
  /** 角色名称（可选，如「审查獭」） */
  roleName?: string
  /** 职责（每条一项，可选） */
  responsibilities?: string[]
}

export function buildOtterSystemPrompt(input: OtterPromptFormInput): string {
  const name = input.name.trim()
  const roleSuffix = input.roleName?.trim() ? `，${input.roleName.trim()}` : ''

  const lines: string[] = []
  lines.push(`你是${name}${roleSuffix}。`)

  const resp = (input.responsibilities ?? []).map(r => r.trim()).filter(Boolean)
  if (resp.length > 0) {
    lines.push('')
    lines.push('职责：')
    for (const r of resp) lines.push(`- ${r}`)
  }

  lines.push('')
  lines.push('协作约定：')
  lines.push('- 完成子任务后把行动权交回召唤者或工作流下一步')
  lines.push('- 不确定的事如实说明，不编造')
  lines.push('- 汇报时先结论后细节')

  return lines.join('\n')
}
