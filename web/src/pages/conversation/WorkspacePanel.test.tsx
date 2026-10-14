// @vitest-environment jsdom
/**
 * WorkspacePanel 测试（F20260831wsui）。
 *
 * 覆盖：
 * 1. 树形渲染：文件夹可展开/收起、子级缩进、排序（文件夹在前）
 * 2. 懒加载：展开时才调 listDir API
 * 3. 内容渲染分发：md→ReactMarkdown / html→sandbox iframe / plain→pre（S1 闭环）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspacePanel } from './WorkspacePanel'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const ROOT_ENTRIES = {
  entries: [
    { name: 'subdir', isDirectory: true, isFile: false, path: 'subdir' },
    { name: 'readme.md', isDirectory: false, isFile: true, path: 'readme.md' },
    { name: 'alpha.txt', isDirectory: false, isFile: true, path: 'alpha.txt' },
  ],
  basePath: '',
  rootPath: '/data/workspaces/test',
}

const SUBDIR_ENTRIES = {
  entries: [
    { name: 'nested-file.html', isDirectory: false, isFile: true, path: 'subdir/nested-file.html' },
    { name: 'deep', isDirectory: true, isFile: false, path: 'subdir/deep' },
  ],
  basePath: 'subdir',
  rootPath: '/data/workspaces/test',
}

function makeFetch(data: unknown): typeof fetch {
  return (() => Promise.resolve(
    new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  )) as unknown as typeof fetch
}

function makeDirFetch(dirData: unknown, subDirData: unknown): typeof fetch {
  return ((url: string) => {
    if (url.includes('path=subdir')) {
      return Promise.resolve(new Response(JSON.stringify(subDirData), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    return Promise.resolve(new Response(JSON.stringify(dirData), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }) as unknown as typeof fetch
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

describe('WorkspacePanel 树形渲染', () => {
  it('根目录条目按排序渲染（文件夹在前、文件在后）', async () => {
    globalThis.fetch = makeFetch(ROOT_ENTRIES)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const tree = container.querySelector('[data-testid="workspace-tree"]')
    expect(tree).not.toBeNull()

    const buttons = tree!.querySelectorAll('button')
    const texts = Array.from(buttons).map(b => b.textContent?.trim())
    const subdirIdx = texts.findIndex(t => t?.includes('subdir'))
    const readmeIdx = texts.findIndex(t => t?.includes('readme.md'))
    const alphaIdx = texts.findIndex(t => t?.includes('alpha.txt'))
    expect(subdirIdx).toBeLessThan(readmeIdx!)
    expect(subdirIdx).toBeLessThan(alphaIdx!)
  })

  it('点击文件夹展开并懒加载子目录', async () => {
    globalThis.fetch = makeDirFetch(ROOT_ENTRIES, SUBDIR_ENTRIES)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const folderBtn = container.querySelector('[data-testid="folder-subdir"]') as HTMLButtonElement
    expect(folderBtn).not.toBeNull()
    await act(async () => { folderBtn.click() })

    const children = container.querySelector('[data-testid="folder-children-subdir"]')
    expect(children).not.toBeNull()
    expect(children!.textContent).toContain('nested-file.html')
    expect(children!.textContent).toContain('deep')
  })

  it('收起文件夹不再渲染子级', async () => {
    globalThis.fetch = makeDirFetch(ROOT_ENTRIES, SUBDIR_ENTRIES)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const folderBtn = container.querySelector('[data-testid="folder-subdir"]') as HTMLButtonElement
    await act(async () => { folderBtn.click() })
    expect(container.querySelector('[data-testid="folder-children-subdir"]')).not.toBeNull()

    await act(async () => { folderBtn.click() })
    expect(container.querySelector('[data-testid="folder-children-subdir"]')).toBeNull()
  })

  it('子级缩进层级递增', async () => {
    globalThis.fetch = makeDirFetch(ROOT_ENTRIES, SUBDIR_ENTRIES)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const folderBtn = container.querySelector('[data-testid="folder-subdir"]') as HTMLButtonElement
    await act(async () => { folderBtn.click() })

    const subBtn = container.querySelector('[data-testid="folder-subdir"]') as HTMLElement
    const nestedBtn = container.querySelector('[data-testid="file-subdir/nested-file.html"]') as HTMLElement
    expect(subBtn).not.toBeNull()
    expect(nestedBtn).not.toBeNull()
    expect(parseInt(nestedBtn.style.paddingLeft)).toBeGreaterThan(parseInt(subBtn.style.paddingLeft))
  })

  it('子目录加载失败时显示错误并可重试（D1）', async () => {
    // 根目录成功，子目录 fetch 500
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_ENTRIES), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(SUBDIR_ENTRIES), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    // 第一次点击：子目录加载失败
    const folderBtn = container.querySelector('[data-testid="folder-subdir"]') as HTMLButtonElement
    await act(async () => { folderBtn.click() })

    // 错误信息可见
    expect(container.textContent).toContain('加载失败')
    // 无子级内容
    expect(container.querySelector('[data-testid="folder-children-subdir"]')).toBeNull()

    // 收起再展开（重试路径）：这次 fetch 成功
    await act(async () => { folderBtn.click() })  // 收起
    await act(async () => { folderBtn.click() })  // 再展开 → 重新 fetch

    const children = container.querySelector('[data-testid="folder-children-subdir"]')
    expect(children).not.toBeNull()
    expect(children!.textContent).toContain('nested-file.html')
  })

  it('头部展示工作区根目录绝对路径', async () => {
    globalThis.fetch = makeFetch(ROOT_ENTRIES)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const pathEl = container.querySelector('[data-testid="workspace-root-path"]')
    expect(pathEl).not.toBeNull()
    expect(pathEl!.textContent).toBe('/data/workspaces/test')
    expect(pathEl!.getAttribute('title')).toBe('/data/workspaces/test')
  })
})

/**
 * 文件预览 Modal 内容渲染分发测试（F20260831wsui 基线 + F20261014pvmd 迁移到 Modal）。
 * 验证分发正确性：
 *  .md → ReactMarkdown、.html → sandbox iframe、图片 → img、其他 → pre；
 *  预览经 portal 挂 document.body（Modal 形态），关闭后内容清除。
 */
describe('文件预览 Modal 内容渲染分发（F20261014pvmd）', () => {
  const FILE_CONTENT_MD = { path: 'readme.md', content: '# Hello', truncated: false }
  const FILE_CONTENT_HTML = { path: 'page.html', content: '<p>Hi</p>', truncated: false }
  const FILE_CONTENT_TXT = { path: 'data.txt', content: 'plain', truncated: false }
  const ROOT_FILE_ENTRIES = {
    entries: [
      { name: 'readme.md', isDirectory: false, isFile: true, path: 'readme.md' },
      { name: 'page.html', isDirectory: false, isFile: true, path: 'page.html' },
      { name: 'data.txt', isDirectory: false, isFile: true, path: 'data.txt' },
    ]
  }

  const FILE_CONTENT_PNG = { path: 'chart.png', content: 'aGVsbG8=', truncated: false, encoding: 'base64' }
  const ROOT_IMG_ENTRIES = {
    entries: [
      { name: 'readme.md', isDirectory: false, isFile: true, path: 'readme.md' },
      { name: 'page.html', isDirectory: false, isFile: true, path: 'page.html' },
      { name: 'data.txt', isDirectory: false, isFile: true, path: 'data.txt' },
      { name: 'chart.png', isDirectory: false, isFile: true, path: 'chart.png' },
    ]
  }

  it('.md → ReactMarkdown / .html → sandbox iframe / .txt → pre / 图片 → img，均在 Modal 内', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_IMG_ENTRIES), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_MD), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_HTML), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_TXT), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_PNG), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    // .md → Modal 内 ReactMarkdown
    const mdFile = container.querySelector('[data-testid="file-readme.md"]') as HTMLButtonElement
    await act(async () => { mdFile.click() })
    // Modal 挂 document.body（portal），断言查 document
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.querySelector('[data-testid="react-markdown"]')).not.toBeNull()
    expect(dialog!.querySelector('[data-testid="html-sandbox"]')).toBeNull()
    expect(dialog!.querySelector('[data-testid="plain-pre"]')).toBeNull()

    // .html → Modal 内 sandbox iframe
    const htmlFile = container.querySelector('[data-testid="file-page.html"]') as HTMLButtonElement
    await act(async () => { htmlFile.click() })
    const dialog2 = document.querySelector('[role="dialog"]')
    expect(dialog2!.querySelector('[data-testid="react-markdown"]')).toBeNull()
    const iframe = dialog2!.querySelector('[data-testid="html-sandbox"]') as HTMLIFrameElement
    expect(iframe).not.toBeNull()
    expect(iframe.hasAttribute('sandbox')).toBe(true)
    expect(iframe.getAttribute('sandbox')).toBe('')
    expect(iframe.srcdoc).toBe('<p>Hi</p>')

    // .txt → Modal 内 pre
    const txtFile = container.querySelector('[data-testid="file-data.txt"]') as HTMLButtonElement
    await act(async () => { txtFile.click() })
    const dialog3 = document.querySelector('[role="dialog"]')
    expect(dialog3!.querySelector('[data-testid="react-markdown"]')).toBeNull()
    expect(dialog3!.querySelector('[data-testid="html-sandbox"]')).toBeNull()
    expect(dialog3!.querySelector('[data-testid="plain-pre"]')).not.toBeNull()

    // 图片（encoding=base64）→ Modal 内 img，src 为 data URL
    const pngFile = container.querySelector('[data-testid="file-chart.png"]') as HTMLButtonElement
    await act(async () => { pngFile.click() })
    const dialog4 = document.querySelector('[role="dialog"]')
    const img = dialog4!.querySelector('[data-testid="image-preview"] img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.src).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('Escape 关闭 Modal 后内容清除', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_MD), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const mdFile = container.querySelector('[data-testid="file-readme.md"]') as HTMLButtonElement
    await act(async () => { mdFile.click() })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('点击遮罩关闭 Modal', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_MD), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const mdFile = container.querySelector('[data-testid="file-readme.md"]') as HTMLButtonElement
    await act(async () => { mdFile.click() })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    // 遮罩 = scrim fixed inset-0（Modal 组件外层 div）
    const scrim = document.querySelector('body > .scrim') as HTMLElement
    expect(scrim).not.toBeNull()
    await act(async () => { scrim.click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('jpg 生成标准 MIME image/jpeg（F20261014pvmd 处置 1）', async () => {
    const jpgContent = { path: 'photo.jpg', content: 'aGVsbG8=', truncated: false, encoding: 'base64' }
    const rootEntries = { entries: [{ name: 'photo.jpg', isDirectory: false, isFile: true, path: 'photo.jpg' }] }
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rootEntries), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(jpgContent), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-photo.jpg"]') as HTMLButtonElement
    await act(async () => { fileBtn.click() })
    const img = document.querySelector('[role="dialog"] [data-testid="image-preview"] img') as HTMLImageElement
    expect(img.src).toBe('data:image/jpeg;base64,aGVsbG8=')
  })

  it('svg 生成 MIME image/svg+xml（F20261014pvmd 处置 1）', async () => {
    const svgContent = { path: 'icon.svg', content: 'aGVsbG8=', truncated: false, encoding: 'base64' }
    const rootEntries = { entries: [{ name: 'icon.svg', isDirectory: false, isFile: true, path: 'icon.svg' }] }
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rootEntries), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(svgContent), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-icon.svg"]') as HTMLButtonElement
    await act(async () => { fileBtn.click() })
    const img = document.querySelector('[role="dialog"] [data-testid="image-preview"] img') as HTMLImageElement
    expect(img.src).toBe('data:image/svg+xml;base64,aGVsbG8=')
  })

  it('无点文件名（名为 png 的文本文件）不误路由为图片（F20261014pvmd 处置 2）', async () => {
    // 后端不会对该文件返回 encoding: 'base64'，前端也不应将其当图片渲染
    const txtContent = { path: 'png', content: 'plain text', truncated: false }
    const rootEntries = { entries: [{ name: 'png', isDirectory: false, isFile: true, path: 'png' }] }
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rootEntries), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(txtContent), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-png"]') as HTMLButtonElement
    await act(async () => { fileBtn.click() })
    const dialog = document.querySelector('[role="dialog"]')
    // 应走 PlainRenderer（pre），而非 ImageRenderer
    expect(dialog!.querySelector('[data-testid="image-preview"]')).toBeNull()
    expect(dialog!.querySelector('[data-testid="plain-pre"]')).not.toBeNull()
  })

  it('截断标记在 Modal 内正确显示', async () => {
    const truncatedContent = { path: 'big.txt', content: 'x'.repeat(102400), truncated: true }
    const rootEntries = { entries: [{ name: 'big.txt', isDirectory: false, isFile: true, path: 'big.txt' }] }
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rootEntries), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(truncatedContent), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-big.txt"]') as HTMLButtonElement
    await act(async () => { fileBtn.click() })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog!.textContent).toContain('已截断')
  })
})

describe('右键菜单 reveal 端点（F20260910wrev）', () => {
  const ROOT_FILE_ENTRIES = {
    entries: [
      { name: 'hello.txt', isDirectory: false, isFile: true, path: 'hello.txt' },
      { name: 'subdir', isDirectory: true, isFile: false, path: 'subdir' },
    ]
  }

  it('右键文件节点弹出菜单，含“在文件管理器中显示”', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-hello.txt"]') as HTMLButtonElement
    await act(async () => {
      fileBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 }))
    })

    // 菜单经 createPortal 挂 document.body（脱离右栏 aside.glass 的 backdrop-filter containing block），断言查 document
    const menu = document.querySelector('[data-testid="workspace-ctx-menu"]')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain('在文件管理器中显示')
    // 菜单不应再渲染在面板容器内（回归断言：防止退回 fixed-in-aside 定位）
    expect(container.querySelector('[data-testid="workspace-ctx-menu"]')).toBeNull()
  })

  it('点击菜单项调用 reveal API（POST + body.path）', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-hello.txt"]') as HTMLButtonElement
    await act(async () => {
      fileBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 }))
    })

    const menuItem = document.querySelector('[data-testid="workspace-ctx-menu"] button') as HTMLButtonElement
    await act(async () => { menuItem.click() })

    // 验证 POST 调用
    const revealCall = mock.mock.calls.find((c: string[]) =>
      typeof c[0] === 'string' && c[0].includes('/workspace/reveal')
    )
    expect(revealCall).toBeDefined()
  })

  it('reveal 失败时显示错误横幅', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '文件不存在' }), { status: 404 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-hello.txt"]') as HTMLButtonElement
    await act(async () => {
      fileBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 }))
    })

    const menuItem = document.querySelector('[data-testid="workspace-ctx-menu"] button') as HTMLButtonElement
    await act(async () => { menuItem.click() })

    expect(container.textContent).toContain('文件不存在')
  })

  it('Safari 兑底：文件节点上 mousedown(button=2) 被 preventDefault（防 Safari 26 原生菜单）', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-hello.txt"]') as HTMLButtonElement
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })
    await act(async () => { fileBtn.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
  })

  it('Safari 兑底：folder 节点 mousedown(button=2) 不拦截（folder 无菜单，拦了反而死区）', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const folderBtn = container.querySelector('[data-testid="folder-subdir"]') as HTMLButtonElement
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })
    await act(async () => { folderBtn.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
  })

  it('Safari 兑底：非树节点区域的 mousedown(button=2) 不拦截', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })
    await act(async () => { container.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
  })
})
