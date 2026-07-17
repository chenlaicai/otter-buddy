/** Mock data for Skills page (only page still using mock data) */

export interface Otter {
  id: string
  name: string
  type: 'big' | 'small'
  createdAt: string
  role?: { name: string; resp: string[] }
  parentOtterId?: string
  ci?: number
}

export interface Skill {
  id: string
  name: string
  desc: string
  type: 'tool' | 'workflow' | 'prompt_template'
  assignedTo: string[]
}

const bigOtter: Otter = {
  id: 'o1',
  name: '大獭',
  type: 'big',
  createdAt: '2026-07-01',
}

const smallOtters: Otter[] = [
  { id: 'o2', name: '分析獭', type: 'small', createdAt: '2026-07-01', role: { name: '方案A视角', resp: ['从用户体验角度分析', '关注易用性'] }, parentOtterId: 'o1', ci: 1 },
  { id: 'o3', name: '测试獭', type: 'small', createdAt: '2026-07-01', role: { name: '方案B视角', resp: ['从技术架构角度分析', '关注可维护性'] }, parentOtterId: 'o1', ci: 2 },
]

export const skills: Skill[] = [
  { id: 'sk1', name: 'code-review', desc: '代码审查能力', type: 'tool', assignedTo: ['o2'] },
  { id: 'sk2', name: 'deep-research', desc: '深度研究能力', type: 'workflow', assignedTo: [] },
  { id: 'sk3', name: 'summary-template', desc: '摘要模板', type: 'prompt_template', assignedTo: ['o3'] },
]

export function getAllOtters(): Otter[] {
  return [bigOtter, ...smallOtters]
}
