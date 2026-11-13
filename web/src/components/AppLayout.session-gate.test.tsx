// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

beforeAll(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })))
})

vi.mock('../api/client', () => ({ getSettings: vi.fn() }))
vi.mock('../hooks/use-session', () => ({
  useSession: () => ({ state: 'unauthenticated', login: vi.fn(), logout: vi.fn() }),
}))

import { AppLayout } from './AppLayout'

describe('AppLayout 会话门守卫（#1868）', () => {
  it('unauthenticated → 渲染登录屏，不挂载业务布局', () => {
    render(<MemoryRouter><AppLayout /></MemoryRouter>)
    expect(screen.getByTestId('owner-token')).toBeTruthy()
    expect(screen.queryByTestId('app-content-scroll')).toBeNull()
  })
})