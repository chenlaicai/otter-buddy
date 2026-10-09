// F20261010 三层滚动取证探针：左栏 / 中栏消息列表 / 页面级（window + AppLayout 兜底容器）
// 注入后全局监听，任何一层 scrollTop 突变都记录带时间戳的事件
(() => {
  if (window.__triProbe) return
  const log = []
  const findScrollParents = el => {
    const list = []
    let n = el
    while (n && n !== document.documentElement) {
      const s = getComputedStyle(n)
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) list.push(n)
      n = n.parentElement
    }
    return list
  }
  const snap = () => {
    // 左栏：aside 内的 overflow-y-auto 容器（LeftPanel.tsx:333 scrollRef）
    const asideEl = document.querySelector('aside')
    const leftScroller = asideEl ? [...asideEl.querySelectorAll('div')].find(d => {
      const s = getComputedStyle(d)
      return s.overflowY === 'auto' && d.scrollHeight > d.clientHeight + 4
    }) ?? null : null
    // 中栏：消息滚动容器（[data-message-id] 向上找 overflow 祖先）
    const msg = document.querySelector('[data-message-id]')
    const msgScroller = msg ? findScrollParents(msg)[0] : null
    // 页面级：window.scrollY + AppLayout 兜底容器
    const appScroll = document.querySelector('[data-testid="app-content-scroll"]')
    return {
      left: leftScroller ? Math.round(leftScroller.scrollTop) : -1,
      leftSh: leftScroller ? leftScroller.scrollHeight : -1,
      msg: msgScroller ? Math.round(msgScroller.scrollTop) : -1,
      msgSh: msgScroller ? msgScroller.scrollHeight : -1,
      win: Math.round(window.scrollY),
      app: appScroll ? Math.round(appScroll.scrollTop) : -1,
      appSh: appScroll ? appScroll.scrollHeight : -1,
    }
  }
  let last = snap()
  window.__triProbe = {
    log,
    frame() {
      const cur = snap()
      const t = performance.now()
      for (const k of ['left', 'msg', 'win', 'app']) {
        if (cur[k] !== last[k] && cur[k] !== -1) {
          log.push({ t: Math.round(t), k, from: last[k], to: cur[k] })
          if (log.length > 400) log.shift()
        }
      }
      last = cur
      requestAnimationFrame(window.__triProbe.frame)
    },
    dump() { return log.slice() },
    clear() { log.length = 0 },
  }
  requestAnimationFrame(window.__triProbe.frame)
  console.log('[tri-probe] 三层滚动监控已挂载')
})()
