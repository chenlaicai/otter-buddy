import { OtterAvatar } from './OtterAvatar'
import type { LocalOtter } from '../lib/mappers'
import type { LocalOtterSession } from '../lib/mappers'
import { sortSessionChain } from '../lib/session-chain'

/** hover 快览卡（D2，~280px，玻璃拟态，向左弹出）。
 *  全部数据来自现有 props，零新接口。 */
export function OtterProfileCard({
  otter,
  sessions,
  modelAlias,
}: {
  otter: LocalOtter
  sessions: LocalOtterSession[]
  modelAlias?: string
}) {
  const isBig = otter.type === 'big'
  const activeSession = sessions.find(s => s.status === 'active')
  const chain = sortSessionChain(sessions)
  const activeGen = activeSession ? chain.indexOf(activeSession) + 1 : 0

  // 称号徽章：规则化派生（D3）
  const badges: string[] = []
  if (isBig) badges.push('族群长老')
  if (activeGen >= 3) badges.push(`${activeGen}世轮回`)
  // "高产" 需要 artifactCount，PR-2 数据到位后启用
  if (otter.role?.name) badges.push(otter.role.name)

  const statusEmoji = activeSession ? '🟢' : '💤'
  const statusText = activeSession ? '活跃' : '休眠'

  return (
    <div className="w-[280px] glass-overlay rounded-2xl p-4 shadow-bubble pointer-events-none select-none">
      {/* 形象区 */}
      <div className="flex items-center gap-3 mb-3">
        <OtterAvatar otterId={otter.id} name={otter.name} size={36} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-stone-700">{otter.name}</div>
          {badges.length > 0 && (
            <div className="flex gap-1 mt-0.5 flex-wrap">
              {badges.slice(0, 2).map(b => (
                <span key={b} className="text-[9px] px-1.5 py-0.5 rounded-full bg-otter-400/15 text-otter-600">
                  {b}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 属性 + 状态 */}
      <div className="flex gap-3 text-[11px] text-stone-500 mb-2">
        <span>{isBig ? '族群长老' : '任务专员'}</span>
        <span>Lv.{activeGen}</span>
        {modelAlias && <span className="truncate">{modelAlias}</span>}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-stone-500">
        <span>{statusEmoji} {statusText}</span>
        {activeSession && (
          <span>第{activeGen}世 · {activeSession.startedAt.split(' ')[1] || activeSession.startedAt}</span>
        )}
      </div>
    </div>
  )
}
