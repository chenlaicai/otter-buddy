import { useEffect, useState } from 'react'

/**
 * 响应式断点 hook（#500）：matchMedia 监听，窗口resize 跨断点时触发重渲染。
 *
 * jsdom 无 matchMedia——守卫返回 false（视为宽屏，三栏全开），
 * 测试环境行为与桌面默认一致，不影响既有组件测试。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    // effect 内同步一次，覆盖 SSR/水合与真实值的偏差
    setMatches(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
