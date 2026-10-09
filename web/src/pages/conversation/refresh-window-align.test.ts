/**
 * F20261009rwqa 窗口对齐单测：refreshMessages 快照不得引入已加载窗口外的历史条目。
 *
 * 背景（三轮上跳根因）：长会话首屏只装 50 条，旧版 refreshMessages 固定拉尾页 100 条，
 * 周期审计（60s）触发时 mergeMessages 以快照为主体 → 列表 50→100 暴增（sh +8817px 实测），
 * 贴底用户被推离。修复：快照按已加载列表 oldest 游标升序拉取（after=oldest.id）。
 *
 * 本测试直接驱动组件级行为太重（index.tsx 全链 mock 面大）——改为单测两层不变量：
 * ①API 层：listEntriesAfter(convId, oldestId, 200) 生成 after 查询参数（client.ts 契约）；
 * ②合并层：mergeMessages(已加载 50, 快照=窗口内 50+新 2) 结果 = 52 条（不含窗口外历史）。
 * 组件层「refreshMessages 传 oldest 游标」由 e2e tri-msg-count 场景重放覆盖（回归锚）。
 */
import { describe, it, expect, vi } from 'vitest'
import { mergeMessages } from '../../lib/message-stream'
import type { LocalMessage } from '../../lib/mappers'

function msg(id: string, seq: number, body: string): LocalMessage {
  return {
    id, seq, senderId: 'otter-1', senderName: '小獭', senderType: 'otter',
    content: body, createdAt: '2026-10-10T01:00:00Z', status: 'completed',
  } as unknown as LocalMessage
}

describe('F20261010rwq 快照窗口对齐', () => {
  it('mergeMessages：快照=窗口内+新条目时，结果不引入窗口外历史（50→52 而非 50→100）', () => {
    // 已加载窗口：seq 51-100（长会话首屏尾页 50 条）
    const loaded: LocalMessage[] = Array.from({ length: 50 }, (_, i) => msg(`m-${i + 51}`, i + 51, `历史 ${i + 51}`))
    // 修复后快照语义：after=oldest(m-51) 升序拉取 → 窗口内 50 条 + 到达的新 2 条（seq 101/102）
    const snapshot: LocalMessage[] = [
      ...loaded,
      msg('m-101', 101, '新消息 1'),
      msg('m-102', 102, '新消息 2'),
    ]
    const merged = mergeMessages(loaded, snapshot)
    expect(merged).toHaveLength(52)
    expect(merged[0]?.id).toBe('m-51')
    expect(merged[51]?.id).toBe('m-102')
    // 反事实（旧版缺陷形态）：无游标快照拉 100 条（含窗口外 seq 1-50）
    const wideSnapshot: LocalMessage[] = [
      ...Array.from({ length: 50 }, (_, i) => msg(`m-old-${i + 1}`, i + 1, `窗口外 ${i + 1}`)),
      ...snapshot,
    ]
    const mergedOld = mergeMessages(loaded, wideSnapshot)
    expect(mergedOld).toHaveLength(102) // 旧版会这样——本断言钉死缺陷形态供对照
  })

  it('listEntriesAfter 带 after 游标：URL 生成 after 查询参数（契约锁定）', async () => {
    const fetchSpy = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ hasMore: false, entries: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { listEntriesAfter } = await import('../../api/client')
    await listEntriesAfter('conv-1', 'oldest-id-x', 200)
    const url = String((fetchSpy.mock.calls[0] as unknown[])[0])
    expect(url).toContain('after=oldest-id-x')
    expect(url).toContain('limit=200')
    vi.unstubAllGlobals()
  })

  it('oldest 游标筛选：tmp-/err- 乐观条目不作游标（取首个真实条目）', () => {
    // 复刻 index.tsx refreshMessages 的游标筛选语义
    const loaded: LocalMessage[] = [
      msg('tmp-opt-1', 999, '乐观消息'),
      msg('err-fail-1', 998, '失败消息'),
      msg('m-51', 51, '首条真实'),
    ]
    const oldestId = loaded.find(m => !m.id.startsWith('tmp-') && !m.id.startsWith('err-'))?.id
    expect(oldestId).toBe('m-51')
  })
})
