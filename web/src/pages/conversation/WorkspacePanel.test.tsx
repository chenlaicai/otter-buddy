// @vitest-environment jsdom
/**
 * WorkspacePanel 树形结构测试（F20260831xxxx）。
 *
 * 覆盖：
 * 1. 树形渲染：文件夹可展开/收起、子级缩进、排序（文件夹在前）
 * 2. 懒加载：展开时才调 listDir API
 *
 * 注：内容渲染（md/html/plain）在浏览器手动验证（react-markdown jsdom OOM）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})
