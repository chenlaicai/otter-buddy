import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Code, Nodes } from 'mdast'
import { remarkHtmlCardIndex } from './remark-html-card-index'

/** 解析 + 转换后收集所有 html-card 和 html-report 围栏的 fenceIndex（按文档序）。
 *  管线与 MessageList 的 REMARK_PLUGINS 对齐（remarkGfm singleTilde:false + index 插件） */
function fenceIndexesOf(md: string): Array<number | undefined> {
  const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkHtmlCardIndex)
  const tree = processor.runSync(processor.parse(md))
  const indexes: Array<number | undefined> = []
  const visit = (node: Nodes) => {
    if (node.type === 'code' && ((node as Code).lang === 'html-card' || (node as Code).lang === 'html-report')) {
      indexes.push((node as Code).data?.hProperties?.dataFenceIndex as number | undefined)
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return indexes
}

describe('remarkHtmlCardIndex（fenceIndex 注解，hProperties 通道）', () => {
  it('按文档序写 0 基序号到 data.hProperties.dataFenceIndex', () => {
    const md = '```html-card\na\n```\n\n文本\n\n```html-card\nb\n```'
    expect(fenceIndexesOf(md)).toEqual([0, 1])
  })

  it('嵌套在 blockquote/list 内的围栏同样按文档序编号', () => {
    const md = '> ```html-card\n> a\n> ```\n\n- ```html-card\n  b\n  ```\n\n```html-card\nc\n```'
    expect(fenceIndexesOf(md)).toEqual([0, 1, 2])
  })

  it('普通代码围栏与 html-card-reply 不参与编号', () => {
    const md = '```js\nx\n```\n\n```html-card\na\n```\n\n```html-card-reply card="m:0"\n{}\n```'
    expect(fenceIndexesOf(md)).toEqual([0])
  })

  it('html-report 围栏参与编号（与 html-card 共享 fenceIndex 序列）', () => {
    const md = '```html-card\na\n```\n\n```html-report title="议题"\nb\n```\n\n```html-card\nc\n```'
    expect(fenceIndexesOf(md)).toEqual([0, 1, 2])
  })

  it('html-report 围栏携带 dataFenceType=hProperties', () => {
    const md = '```html-report title="议题"\nb\n```'
    const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkHtmlCardIndex)
    const tree = processor.runSync(processor.parse(md))
    const visit = (node: Nodes): Code | undefined => {
      if (node.type === 'code') return node as Code
      if ('children' in node) for (const child of node.children) { const r = visit(child); if (r) return r; }
    }
    const code = visit(tree)
    expect(code.data?.hProperties?.dataFenceType).toBe('html-report')
  })
})
