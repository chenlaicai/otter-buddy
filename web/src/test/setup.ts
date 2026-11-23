import { vi } from 'vitest'

// jsdom 没有布局观察器；真实组件挂载时需要标准 ResizeObserver 接口。
// 各测试若需要尺寸回调，可在本文件之后覆盖为自己的可控实现。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
}
