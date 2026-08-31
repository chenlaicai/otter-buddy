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
  ]
}

const SUBDIR_ENTRIES = {
  entries: [
    { name: 'nested-file.html', isDirectory: false, isFile: true, path: 'subdir/nested-file.html' },
    { name: 'deep', isDirectory: true, isFile: false, path: 'subdir/deep' },
  ]
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
})

/**
 * FileContentViewer 内容渲染分发测试（S1 闭环，F20260831wsui）。
 * 验证分发正确性：
 *  .md → ReactMarkdown 组件、.html → sandbox iframe、其他 → pre。
 */
describe('FileContentViewer 内容渲染分发（S1 闭环）', () => {
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

  it('.md → ReactMarkdown / .html → sandbox iframe / .txt → pre', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ROOT_FILE_ENTRIES), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_MD), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_HTML), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FILE_CONTENT_TXT), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    // .md → ReactMarkdown
    const mdFile = container.querySelector('[data-testid="file-readme.md"]') as HTMLButtonElement
    await act(async () => { mdFile.click() })
    expect(container.querySelector('[data-testid="react-markdown"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="html-sandbox"]')).toBeNull()
    expect(container.querySelector('[data-testid="plain-pre"]')).toBeNull()

    // .html → sandbox iframe
    const htmlFile = container.querySelector('[data-testid="file-page.html"]') as HTMLButtonElement
    await act(async () => { htmlFile.click() })
    expect(container.querySelector('[data-testid="react-markdown"]')).toBeNull()
    const iframe = container.querySelector('[data-testid="html-sandbox"]') as HTMLIFrameElement
    expect(iframe).not.toBeNull()
    expect(iframe.hasAttribute('sandbox')).toBe(true)
    expect(iframe.getAttribute('sandbox')).toBe('')
    expect(iframe.srcdoc).toBe('<p>Hi</p>')

    // .txt → pre
    const txtFile = container.querySelector('[data-testid="file-data.txt"]') as HTMLButtonElement
    await act(async () => { txtFile.click() })
    expect(container.querySelector('[data-testid="react-markdown"]')).toBeNull()
    expect(container.querySelector('[data-testid="html-sandbox"]')).toBeNull()
    expect(container.querySelector('[data-testid="plain-pre"]')).not.toBeNull()
  })

  it('截断标记正确显示', async () => {
    const truncatedContent = { path: 'big.txt', content: 'x'.repeat(102400), truncated: true }
    const rootEntries = { entries: [{ name: 'big.txt', isDirectory: false, isFile: true, path: 'big.txt' }] }
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rootEntries), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(truncatedContent), { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await act(async () => { root.render(<WorkspacePanel conversationId="test" />) })

    const fileBtn = container.querySelector('[data-testid="file-big.txt"]') as HTMLButtonElement
    await act(async () => { fileBtn.click() })
    expect(container.textContent).toContain('已截断')
  })
})
