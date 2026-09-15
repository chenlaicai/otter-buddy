import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SessionModal } from './SessionModal'
import type { LocalOtter } from '../../lib/mappers'
import * as api from '../../api/client'

/** F20260914evdz：实时通道 mock（buffer + listeners，空实现） */
import type { SessionLiveItem } from './SessionModal'
const liveEvents = { current: [] as SessionLiveItem[] }
const liveListeners = { current: new Set<(e: SessionLiveItem) => void>() }

/** F20260914rtsp：Session 弹窗升级（自动展开 + 折叠视图）测试 */

vi.mock('../../api/client', () => ({
  listInvokes: vi.fn(),
  getInvokeEvents: vi.fn(),
}))

const otter: LocalOtter = {
  id: 'otter-1', name: '检视獭', type: 'small', status: 'active',
  role: null, parentOtterId: null, createdAt: '', dissolvedAt: null,
  modelAlias: 'mimo', modelIsDefault: false,
} as unknown as LocalOtter

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('SessionModal（F20260914rtsp）', () => {
  it('打开后自动展开最新 invoke（running 优先）并渲染折叠视图', async () => {
    vi.mocked(api.listInvokes).mockResolvedValue({
      invokes: [
        { id: 'inv-running', status: 'running', startedAt: '2026-09-14T10:00:00Z', toolCallCount: 2, ctxWindowUsed: 45200, tokenUsageInput: null, tokenUsageOutput: null } as never,
        { id: 'inv-old', status: 'completed', startedAt: '2026-09-14T09:00:00Z', toolCallCount: 1, ctxWindowUsed: null, tokenUsageInput: 100, tokenUsageOutput: 50 } as never,
      ],
      hasMore: false,
    })
    // speak 事件吸收同名 start（真实落库形态：e4 是 speak 的 tool_execution_end 特判落库）
    // —— 不再有第二条假「执行中」speak 工具行（F20260914evdz）
    vi.mocked(api.getInvokeEvents).mockResolvedValue({
      invoke: {} as never,
      events: [
        // 同一次调用 start + result → 折叠为一行；message_end 快照丢弃
        { id: 'e1', invokeId: 'inv-running', eventType: 'assistant_toolcall', payload: { name: 'read', arguments: { path: 'a' } }, sequenceNum: 1, createdAt: '2026-09-14T10:00:01Z' },
        { id: 'e2', invokeId: 'inv-running', eventType: 'tool_result', payload: { name: 'read', result: 'content' }, sequenceNum: 2, createdAt: '2026-09-14T10:00:02Z' },
        { id: 'e3', invokeId: 'inv-running', eventType: 'assistant_toolcall', payload: { content: [{ type: 'toolCall' }] }, sequenceNum: 3, createdAt: '2026-09-14T10:00:03Z' },
        { id: 'e4s', invokeId: 'inv-running', eventType: 'assistant_toolcall', payload: { name: 'speak', arguments: { body: '排查完成' } }, sequenceNum: 4, createdAt: '2026-09-14T10:00:04Z' },
        { id: 'e4', invokeId: 'inv-running', eventType: 'speak', payload: { body: '排查完成' }, sequenceNum: 5, createdAt: '2026-09-14T10:00:05Z' },
      ],
    })

    render(<SessionModal otter={otter} conversationId="conv-1" onClose={() => {}} liveEvents={liveEvents} liveListeners={liveListeners} />)

    // running invoke 自动加载事件（无需手点）
    await waitFor(() => expect(api.getInvokeEvents).toHaveBeenCalledWith('inv-running'))
    // 折叠视图：read 调用一行 + speak 一行（快照 e3 丢弃；speak start 被 e4 吸收，不出现第三条工具行）
    await waitFor(() => {
      const callSteps = screen.getAllByTestId('folded-call-step')
      expect(callSteps).toHaveLength(1)
      expect(callSteps[0].textContent).toContain('read')
    })
    // speak 步直通渲染（label 精确匹配；body 内容另断言）
    expect(screen.getByText('发言', { exact: true })).toBeTruthy()
    expect(screen.getByText('排查完成')).toBeTruthy()
    // running 指示条
    expect(screen.getByTestId('live-follow-indicator')).toBeTruthy()
    // 未展开的旧 invoke 不自动加载
    expect(api.getInvokeEvents).not.toHaveBeenCalledWith('inv-old')
  })

  it('无 invoke 时显示空态', async () => {
    vi.mocked(api.listInvokes).mockResolvedValue({ invokes: [], hasMore: false })
    render(<SessionModal otter={otter} conversationId="conv-1" onClose={() => {}} liveEvents={liveEvents} liveListeners={liveListeners} />)
    await waitFor(() => expect(screen.getByText(/暂无 invoke 记录/)).toBeTruthy())
  })

  it('终态 invoke 里未配对的 start 显示「已中断」而非假转圈（F20260914evdz）', async () => {
    vi.mocked(api.listInvokes).mockResolvedValue({
      invokes: [
        { id: 'inv-done', status: 'completed', startedAt: '2026-09-14T09:00:00Z', toolCallCount: 2, ctxWindowUsed: null, tokenUsageInput: null, tokenUsageOutput: null } as never,
      ],
      hasMore: false,
    })
    // 中断现场：bash 有 start 无 result；speak start 有吸收；最后一条 read 正常配对
    vi.mocked(api.getInvokeEvents).mockResolvedValue({
      invoke: {} as never,
      events: [
        { id: 'x1', invokeId: 'inv-done', eventType: 'assistant_toolcall', payload: { name: 'bash', arguments: { command: 'sleep 100' } }, sequenceNum: 1, createdAt: '2026-09-14T09:00:01Z' },
        { id: 'x2', invokeId: 'inv-done', eventType: 'assistant_toolcall', payload: { name: 'read', arguments: { path: 'a' } }, sequenceNum: 2, createdAt: '2026-09-14T09:00:02Z' },
        { id: 'x3', invokeId: 'inv-done', eventType: 'tool_result', payload: { name: 'read', result: 'ok' }, sequenceNum: 3, createdAt: '2026-09-14T09:00:03Z' },
      ],
    })

    render(<SessionModal otter={otter} conversationId="conv-1" onClose={() => {}} liveEvents={liveEvents} liveListeners={liveListeners} />)

    await waitFor(() => {
      // bash 行显示「已中断」，不再有「执行中…」
      expect(screen.getByText('已中断')).toBeTruthy()
      expect(screen.queryByText(/执行中/)).toBeNull()
    })
  })
})
