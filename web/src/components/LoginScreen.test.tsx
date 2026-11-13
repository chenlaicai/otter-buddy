// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { LoginScreen } from './LoginScreen'

describe('LoginScreen（登录屏守卫）', () => {
  it('空 token 时提交按钮禁用', () => {
    render(<LoginScreen onLogin={vi.fn()} error={null} />)
    expect((screen.getByTestId('login-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('提交调用 onLogin（token trim 后）', async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<LoginScreen onLogin={onLogin} error={null} />)
    fireEvent.change(screen.getByTestId('owner-token'), { target: { value: '  secret  ' } })
    fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('secret'))
  })

  it('渲染错误信息', () => {
    render(<LoginScreen onLogin={vi.fn()} error="token 不正确" />)
    expect(screen.getByTestId('login-error').textContent).toBe('token 不正确')
  })
})