import { describe, it, expect } from 'vitest'
import type { LocalMessage } from './mappers'
import { isInFlight, isTerminal, upsertMessage, insertBySeq, mergeMessages, findStaleInFlight, upsertTerminalMessage } from './message-stream'

function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', st: 'otter', si: 'otter-1', content: 'hello',
    status: 'completed', ts: '2026-07-24T00:00:00Z', dur: null,
    ...overrides,
  }
}

describe('isInFlight / isTerminal', () => {
  it('streaming/speaking 的 otter 消息为进行中', () => {
    expect(isInFlight(msg({ status: 'streaming' }))).toBe(true)
    expect(isInFlight(msg({ status: 'speaking' }))).toBe(true)
    expect(isInFlight(msg({ status: 'completed' }))).toBe(false)
    expect(isInFlight(msg({ status: 'failed' }))).toBe(false)
    expect(isInFlight(msg({ status: 'aborted' }))).toBe(false)
  })

  it('user/system 消息即使 status 异常也不算进行中', () => {
    expect(isInFlight(msg({ st: 'user', si: 'user', status: 'streaming' }))).toBe(false)
  })

  it('status 缺失（SSE 构造）视同终态', () => {
    expect(isInFlight(msg({ status: undefined }))).toBe(false)
    expect(isTerminal(msg({ status: undefined }))).toBe(true)
  })
})

describe('upsertMessage', () => {
  it('同 id 原位替换，保持位置', () => {
    const list = [msg({ id: 'a' }), msg({ id: 'b', status: 'streaming' }), msg({ id: 'c' })]
    const next = upsertMessage(list, msg({ id: 'b', status: 'completed', content: 'done' }))
    expect(next.map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(next[1].content).toBe('done')
  })

  it('不存在则追加到末尾', () => {
    const next = upsertMessage([msg({ id: 'a' })], msg({ id: 'b' }))
    expect(next.map(m => m.id)).toEqual(['a', 'b'])
  })
})

describe('insertBySeq（M5：按服务端 sequence 插入）', () => {
  it('插到第一个 seq 更大的消息之前', () => {
    const list = [msg({ id: 'a', seq: 1 }), msg({ id: 'c', seq: 5 })]
    const next = insertBySeq(list, msg({ id: 'b', seq: 3, status: 'streaming' }))
    expect(next.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('并发 otter start 乱序到达时按 seq 归位', () => {
    let list = [msg({ id: 'u', st: 'user', si: 'user', seq: 1 })]
    /** seq=3 的 otter B 先到，seq=2 的 otter A 后到 */
    list = insertBySeq(list, msg({ id: 'b', seq: 3, status: 'streaming' }))
    list = insertBySeq(list, msg({ id: 'a', seq: 2, status: 'streaming' }))
    expect(list.map(m => m.id)).toEqual(['u', 'a', 'b'])
  })

  it('无 seq 的 tmp 消息不参与比较，新消息插到其前（若有更大 seq 的真实消息）', () => {
    const list = [msg({ id: 'a', seq: 1 }), msg({ id: 'tmp-1', st: 'user', si: 'user' })]
    const next = insertBySeq(list, msg({ id: 'b', seq: 2, status: 'streaming' }))
    expect(next.map(m => m.id)).toEqual(['a', 'tmp-1', 'b'])
  })

  it('同 id 原位替换（轮询快照已带入的占位消息）', () => {
    const list = [msg({ id: 'a', seq: 1 }), msg({ id: 'b', seq: 2, status: 'streaming' })]
    const next = insertBySeq(list, msg({ id: 'b', seq: 2, status: 'streaming', content: 'x' }))
    expect(next.map(m => m.id)).toEqual(['a', 'b'])
    expect(next).toHaveLength(2)
  })

  it('msg 无 seq 时追加到末尾', () => {
    const next = insertBySeq([msg({ id: 'a', seq: 1 })], msg({ id: 'b' }))
    expect(next.map(m => m.id)).toEqual(['a', 'b'])
  })
})

describe('mergeMessages', () => {
  it('过期快照不回退本地已终态的消息（M1）', () => {
    const current = [msg({ id: 'a', status: 'completed', content: '本地已完成' })]
    const snapshot = [msg({ id: 'a', status: 'streaming', content: '' })]
    const next = mergeMessages(current, snapshot)
    expect(next[0].status).toBe('completed')
    expect(next[0].content).toBe('本地已完成')
  })

  it('本地进行中 + 快照终态 → 采用快照', () => {
    const current = [msg({ id: 'a', status: 'streaming', content: '' })]
    const snapshot = [msg({ id: 'a', status: 'completed', content: '服务端完成' })]
    const next = mergeMessages(current, snapshot)
    expect(next[0].status).toBe('completed')
    expect(next[0].content).toBe('服务端完成')
  })

  it('双方进行中时保留 events 更长的一方（M7）', () => {
    const evts = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: '2026-07-24T00:00:00Z', eventType: 'assistant_text', payload: { i } }))
    const current = [msg({ id: 'a', status: 'streaming', events: evts(5) })]
    const snapshot = [msg({ id: 'a', status: 'streaming', events: evts(3) })]
    expect(mergeMessages(current, snapshot)[0].events).toHaveLength(5)
    expect(mergeMessages(snapshot, current)[0].events).toHaveLength(5)
  })

  it('保留快照窗口外的进行中消息（F2a），丢弃窗口外的终态消息', () => {
    const current = [
      msg({ id: 'old-inflight', status: 'streaming', content: '' }),
      msg({ id: 'old-done', status: 'completed' }),
    ]
    const snapshot = [msg({ id: 'new', seq: 200 })]
    const next = mergeMessages(current, snapshot)
    expect(next.map(m => m.id)).toEqual(['new', 'old-inflight'])
  })

  it('tmp 消息在快照有等价内容时被丢弃（N1），多重集匹配不误判重复内容（F6）', () => {
    const tmp1 = msg({ id: 'tmp-1', st: 'user', si: 'user', content: '继续' })
    const tmp2 = msg({ id: 'tmp-2', st: 'user', si: 'user', content: '继续' })
    /** 快照只有一条"继续"（第一条已上服务器），第二条 tmp 必须保留 */
    const snapshot = [msg({ id: 'real-1', st: 'user', si: 'user', content: '继续', seq: 10 })]
    const next = mergeMessages([tmp1, tmp2], snapshot)
    expect(next.map(m => m.id)).toEqual(['real-1', 'tmp-2'])
  })

  it('err- 前缀的本地错误消息被保留（N7）', () => {
    const current = [msg({ id: 'err-abc', status: 'failed', content: '[错误] x' })]
    const snapshot = [msg({ id: 'a', seq: 1 })]
    expect(mergeMessages(current, snapshot).map(m => m.id)).toEqual(['a', 'err-abc'])
  })
})

describe('findStaleInFlight（F20260805abpp：/after 增量不含游标消息自身的状态迁移）', () => {
  it('in-flight 恰好是最新消息（增量恒为空）时必须被挑出定点拉取', () => {
    const list = [msg({ id: 'a', seq: 1 }), msg({ id: 'b', seq: 2, status: 'streaming' })]
    const stale = findStaleInFlight(list, new Set())
    expect(stale.map(m => m.id)).toEqual(['b'])
  })

  it('终态消息、tmp/err 本地消息、已在增量中的消息都被排除', () => {
    const list = [
      msg({ id: 'done', status: 'completed' }),
      msg({ id: 'aborted', status: 'aborted' }),
      /** tmp/err 前缀即使状态像 in-flight 也必须排除（本地乐观消息无服务器对应物） */
      msg({ id: 'tmp-x', status: 'streaming', content: '' }),
      msg({ id: 'err-x', status: 'streaming', content: '' }),
      msg({ id: 'fresh', status: 'streaming' }),
    ]
    const stale = findStaleInFlight(list, new Set(['fresh']))
    expect(stale).toEqual([])
  })

  it('speaking 状态同样视为 in-flight 需定点拉取', () => {
    const list = [msg({ id: 's', status: 'speaking' })]
    expect(findStaleInFlight(list, new Set()).map(m => m.id)).toEqual(['s'])
  })

  it('user 消息不视为 in-flight，即使 status 异常', () => {
    const list = [msg({ id: 'u', st: 'user', si: 'user', status: 'streaming' })]
    expect(findStaleInFlight(list, new Set())).toEqual([])
  })
})

describe('upsertTerminalMessage（F20260805abpp 第四轮检视 S4-1：终态事件不得降级已有投影）', () => {
  const evts = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: '2026-08-05T00:00:00Z', eventType: 'assistant_toolcall', payload: { i } }))

  it('incoming 缺 events/seq/ts 时保留已有投影字段（MPA 新页面 live 状态为空）', () => {
    const existing = msg({ id: 'a', status: 'streaming', seq: 7, ts: '2026-08-05T01:00:00Z', events: evts(3), ctx: 100, turnId: 't1' })
    const incoming = msg({ id: 'a', status: 'aborted', ts: '', seq: undefined, events: undefined, ctx: undefined, ctxMax: undefined, turnId: undefined })
    const next = upsertTerminalMessage([existing], incoming)
    expect(next[0].status).toBe('aborted')
    expect(next[0].events).toHaveLength(3)
    expect(next[0].seq).toBe(7)
    expect(next[0].ts).toBe('2026-08-05T01:00:00Z')
    expect(next[0].ctx).toBe(100)
    expect(next[0].turnId).toBe('t1')
  })

  it('incoming 携带的字段优先（complete 事件的 ctx/turnId 不被旧占位覆盖）', () => {
    const existing = msg({ id: 'a', status: 'streaming', seq: 7, ts: '2026-08-05T01:00:00Z', events: evts(1) })
    const incoming = msg({ id: 'a', status: 'completed', ts: '', events: evts(5), ctx: 999, ctxMax: 1000, turnId: 't2' })
    const next = upsertTerminalMessage([existing], incoming)
    expect(next[0].events).toHaveLength(5)
    expect(next[0].ctx).toBe(999)
    expect(next[0].turnId).toBe('t2')
    expect(next[0].seq).toBe(7)
    expect(next[0].ts).toBe('2026-08-05T01:00:00Z')
  })

  it('消息不存在时直接插入并补 ts', () => {
    const next = upsertTerminalMessage([], msg({ id: 'x', status: 'completed', ts: '' }))
    expect(next).toHaveLength(1)
    expect(next[0].ts).not.toBe('')
  })
})
