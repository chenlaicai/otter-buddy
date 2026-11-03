import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OpticalGlassButton } from './OpticalGlassButton'

describe('光学玻璃按钮', () => {
  it('保留原生按钮的可访问名称、点击和禁用行为', () => {
    let clicks = 0
    const { rerender } = render(
      <OpticalGlassButton width={36} height={36} radius={12} aria-label="发送" onClick={() => { clicks += 1 }}>↑</OpticalGlassButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(clicks).toBe(1)

    rerender(<OpticalGlassButton width={36} height={36} radius={12} aria-label="发送" disabled>↑</OpticalGlassButton>)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button'))
    expect(clicks).toBe(1)
  })

  it('内容在折射层之外，不随玻璃纹理变形', () => {
    const { container } = render(
      <OpticalGlassButton width={56} height={56} radius={18} shape="squircle" aria-label="打开助手">獭</OpticalGlassButton>,
    )
    const button = screen.getByRole('button', { name: '打开助手' })
    expect(button.querySelector('.optical-glass__lens')?.getAttribute('aria-hidden')).toBe('true')
    expect(button.querySelector('.optical-glass__content')?.textContent).toBe('獭')
    expect((button.querySelector('.optical-glass__content') as HTMLElement).style.filter).toBe('')
    expect(button.querySelector('feImage')?.getAttribute('href')).toBe('/glass/lens-squircle.png')
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
