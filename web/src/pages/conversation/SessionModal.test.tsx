import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SessionModal } from './SessionModal'
import type { LocalOtter } from '../../lib/mappers'
import * as api from '../../api/client'

/** F20260914evdz：实时通道 mock（buffer + listeners，空实现） */
import type { SessionLiveItem } from './SessionModal'
const liveEvents = { current: [] as SessionLiveItem[] }
const liveListeners = { current: new Set<(e: SessionLiveItem) => void>() }

/** F20260914rtsp：Session 弹窗升级（自动展开 + 折叠视图）测试。
 *  F20260918sesp：主从双栏重构——自动选中（running 优先）+ 左栏索引/右栏事件流分栏 +
 *  user_injection 步（steer 可见）验证。 */

vi.mock('../../api/client', () => ({
  listInvokes: vi.fn(),
  getInvokeEvents: vi.fn(),
}))

const otter: LocalOtter = {
  id: 'otter-1', name: '检视獭', type: 'small', status: 'active',
  role: null, parentOtterId: null, createdAt: '', dissolvedAt: null,
  modelAlias: 'mimo', modelIsDefault: false,
} as unknown as LocalOtter

function inv(id: string, status: string, startedAt: string): never {
  return { id, status, startedAt, toolCallCount: 1, ctxWindowUsed: null, tokenUsageInput: null, tokenUsageOutput: null, conversationId: 'conv-1', otterId: 'otter-1' } as never
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('SessionModal（F20260918sesp 主从双栏）', () => {
  it('打开后自动选中最新 invoke（running 优先）并渲染折叠视图', async () => {
    vi.mocked(api.listInvokes).mockResolvedValue({
      invokes: [
        inv('inv-running', 'running', '2026-09-14T10:00:00Z'),
        inv('inv-old', 'completed', '2026-09-14T09:00:00Z'),
      ],
      hasMore: false,
    })
    // speak 事件吸收同名 start（真实落库形态）——F20260918sesp：user_injection 首条为触发 prompt
    vi.mocked(api.getInvokeEvents).mockResolvedValue({
      invoke: {} as never,
      events: [
        { id: 'u1', invokeId: 'inv-running', eventType: 'user_injection', payload: { content: '排查一下这个问题' }, sequenceNum: 1, createdAt: '2026-09-14T10:00:00Z' },
        { id: 'e1', invokeId: 'inv-running', eventType: 'assistant_toolcall', payload: { name: 'read', arguments: { path: 'a' } }, sequenceNum: 2, createdAt: '2026-09-14T10:00:01Z' },
        { id: 'e2', invokeId: 'inv-running', eventType: 'tool_result', payload: { name: 'read', result: 'content' }, sequenceNum: 3, createdAt: '2026-09-14T10:00:02Z' },
        { id: 'e3', invokeId: 'inv-running', eventType: 'assistant_toolcall', payload: { content: [{ type: 'toolCall' }] }, sequenceNum: 4, createdAt: '2026-09-14T10:00:03Z' },
        { id: 'e4s', invokeId: 'inv-running', eventType: 'assistant_toolcall', payload: { name: 'speak', arguments: { body: '排查完成' } }, sequenceNum: 5, createdAt: '2026-09-14T10:00:04Z' },
        { id: 'e4', invokeId: 'inv-running', eventType: 'speak', payload: { body: '排查完成' }, sequenceNum: 6, createdAt: '2026-09-14T10:00:05Z' },
      ],
    })

    render(<SessionModal otter={otter} conversationId="conv-1" onClose={() => {}} liveEvents={liveEvents} liveListeners={liveListeners} />)

    // running invoke 自动加载事件（无需手点）
    await waitFor(() => expect(api.getInvokeEvents).toHaveBeenCalledWith('inv-running'))
    // 折叠视图：read 调用一行 + speak 一行（快照 e3 丢弃；speak start 被 e4 吸收）
    await waitFor(() => {
      const callSteps = screen.getAllByTestId('folded-call-step')
      expect(callSteps).toHaveLength(1)
      expect(callSteps[0].textContent).toContain('read')
    })
    // user_injection 步渲染（F20260918sesp：触发 prompt 可见）
    expect(screen.getByTestId('folded-user-step').textContent).toContain('排查一下这个问题')
    expect(screen.getByText('发言', { exact: true })).toBeTruthy()
    expect(screen.getByText('排查完成')).toBeTruthy()
    // running 指示条
    expect(screen.getByTestId('live-follow-indicator')).toBeTruthy()
    // 未选中的旧 invoke 不自动加载
    expect(api.getInvokeEvents).not.toHaveBeenCalledWith('inv-old')
  })

  it('左栏两条 invoke，点击旧项切换右栏（双栏互不干扰）', async () => {
    vi.mocked(api.listInvokes).mockResolvedValue({
      invokes: [
        inv('inv-new', 'completed', '2026-09-14T10:00:00Z'),
        inv('inv-old', 'completed', '2026-09-14T09:00:00Z'),
      ],
      hasMore: false,
    })
    vi.mocked(api.getInvokeEvents).mockResolvedValue({
      invoke: {} as never,
      events: [
        { id: 'u1', invokeId: 'inv-old', eventType: 'user_injection', payload: { content: '旧任务 prompt' }, sequenceNum: 1, createdAt: '2026-09-14T09:00:00Z' },
      ],
    })

    render(<SessionModal otter={otter} conversationId="conv-1" onClose={() => {}} liveEvents={liveEvents} liveListeners={liveListeners} />)

    // 自动选中最新（无 running 时第一条）
    await waitFor(() => expect(api.getInvokeEvents).toHaveBeenCalledWith('inv-new'))
    // 左栏索引含两条（徽章计数限定在左栏容器内——右栏头部也有状态徽章）
    const index = screen.getByTestId('invoke-index')
    const badges = index.querySelectorAll('button > div:first-child span:first-child')
    expect(badges).toHaveLength(2)
    // 点击旧项切换（左栏最后一个按钮 = 列表末尾的旧 invoke）
    const indexButtons = index.querySelectorAll('button')
    expect(indexButtons).toHaveLength(2)
    fireEvent.click(indexButtons[1]!)
    await waitFor(() => expect(api.getInvokeEvents).toHaveBeenCalledWith('inv-old'))
    await waitFor(() => expect(screen.getByTestId('folded-user-step').textContent).toContain('旧任务 prompt'))
  })

  it('steer 注入的消费点插在工具调用之间（F20260918sesp 核心场景）', async () => {
    vi.mocked(api.listInvokes).mockResolvedValue({
      invokes: [inv('inv-running', 'running', '2026-09-14T10:00:00Z')],
      hasMore: false,
    })
    vi.mocked(api.getInvokeEvents).mockResolvedValue({
      invoke: {} as never,
      events: [
        { id: 'u1', invokeId: 'inv-running', eventType: 'user_injection', payload: { content: '改完这个文件' }, sequenceNum: 1, createdAt: '2026-09-14T10:00:00Z' },
        { id: 'e1', invokeId: 'inv-running', eventType: 'assistant_toolcall', payload: { name: 'read', arguments: { path: 'a' } }, sequenceNum: 2, createdAt: '2026-09-14T10:00:01Z' },
        { id: 'e2', invokeId: 'inv-running', eventType: 'tool_result', payload: { name: 'read', result: 'ok' }, sequenceNum: 3, createdAt: '2026-09-14T10:00:02Z' },
        { id: 'u2', invokeId: 'inv-running', eventType: 'user_injection', payload: { content: '【急讯 msg:9】来自 chen：先别改文件，等一下' }, sequenceNum: 4, createdAt: '2026-09-14T10:00:03Z' },
        { id: 'e3', invokeId: 'inv-running', eventType: 'assistant_toolcall', payload: { name: 'speak', arguments: { body: '好' } }, sequenceNum: 5, createdAt: '2026-09-14T10:00:04Z' },
      ],
    })

    render(<SessionModal otter={otter} conversationId="conv-1" onClose={() => {}} liveEvents={liveEvents} liveListeners={liveListeners} />)

    await waitFor(() => {
      const userSteps = screen.getAllByTestId('folded-user-step')
      expect(userSteps).toHaveLength(2)
      expect(userSteps[1].textContent).toContain('先别改文件，等一下')
    })
  })

  it('无 invoke 时显示空态', async () => {
    vi.mocked(api.listInvokes).mockResolvedValue({ invokes: [], hasMore: false })
    render(<SessionModal otter={otter} conversationId="conv-1" onClose={() => {}} liveEvents={liveEvents} liveListeners={liveListeners} />)
    await waitFor(() => expect(screen.getByText(/暂无 invoke 记录/)).toBeTruthy())
  })

  it('终态 invoke 里未配对的 start 显示「已中断」而非假转圈（F20260914evdz）', async () => {
    vi.mocked(api.listInvokes).mockResolvedValue({
      invokes: [inv('inv-done', 'completed', '2026-09-14T09:00:00Z')],
      hasMore: false,
    })
    // 中断现场：bash 有 start 无 result；最后一条 read 正常配对
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
