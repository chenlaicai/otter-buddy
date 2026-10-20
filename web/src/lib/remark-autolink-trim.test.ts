import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Link, Nodes } from 'mdast'
import { remarkAutolinkTrim } from './remark-autolink-trim'

/** 管线与 MessageList 的 REMARK_PLUGINS 对齐（remarkGfm singleTilde:false） */
function parse(md: string) {
  const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkAutolinkTrim)
  return processor.runSync(processor.parse(md))
}

function linksOf(tree: Nodes): Link[] {
  const links: Link[] = []
  const visit = (node: Nodes) => {
    if (node.type === 'link') links.push(node as Link)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return links
}

function textOf(tree: Nodes): string {
  let out = ''
  const visit = (node: Nodes) => {
    if (node.type === 'text') out += node.value
    if (node.type === 'link') for (const c of (node as Link).children) visit(c)
    else if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return out
}

describe('remarkAutolinkTrim（F20261020wabt：GFM autolink 全角尾巴修剪）', () => {
  it('剥离全角标点尾巴：搭档实证现场（消息含句号结尾）', () => {
    const tree = parse('任务已完成，服务仍在运行（http://127.0.0.1:5000）。')
    const [link] = linksOf(tree)
    expect(link.url).toBe('http://127.0.0.1:5000')
    // 链接文本同步修剪（展示不误导）；尾巴回到链接外文本流
    expect(link.children[0].type === 'text' && link.children[0].value).toBe('http://127.0.0.1:5000')
    expect(textOf(tree)).toContain('）。')
    expect(textOf(tree).indexOf('）。')).toBeGreaterThan(textOf(tree).indexOf(':5000'))
  })

  it('剥离全角尾巴+中文尾巴（F20260920alnk 同款现场）', () => {
    const [link] = linksOf(parse('双绿（https://github.com/x/pull/1053）。本地偶发'))
    expect(link.url).toBe('https://github.com/x/pull/1053')
  })

  it('干净链接不动（尾部合法字符直通）', () => {
    const [link] = linksOf(parse('见 https://github.com/x/pull/1053 这里'))
    expect(link.url).toBe('https://github.com/x/pull/1053')
  })

  it('URL 内合法半角标点保留（query/fragment 不被误剥）', () => {
    const [link] = linksOf(parse('https://example.com/a?b=c&d=e#frag'))
    expect(link.url).toBe('https://example.com/a?b=c&d=e#frag')
  })

  it('GFM 处理的半角右括号维持原语义（GFM 已排除的尾巴不出现）', () => {
    const links = linksOf(parse('(see https://example.com/a(b))'))
    expect(links.length).toBeGreaterThan(0)
    // GFM 标准行为：平衡的 ) 属 URL；插件不得把合法 ) 剥掉
    expect(links[0].url).toContain('a(b)')
  })

  it('作者显式链接 [label](url) 不动（非 autolink，文本与 url 无关）', () => {
    const [link] = linksOf(parse('[PR1053](https://github.com/x/pull/1053)。'))
    expect(link.url).toBe('https://github.com/x/pull/1053')
    expect(link.children[0].type === 'text' && link.children[0].value).toBe('PR1053')
  })

  it('裸链段落与 remarkBareLink 协作：修剪后 url 与文本一致仍标记裸链（unfurl 升级不误伤）', () => {
    const links = linksOf(parse('https://example.com/x'))
    expect(links[0].url).toBe('https://example.com/x')
    const text = links[0].children.map(c => (c.type === 'text' ? c.value : '')).join('')
    expect(text).toBe('https://example.com/x')
  })
})
