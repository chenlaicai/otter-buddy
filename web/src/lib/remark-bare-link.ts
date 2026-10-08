import type { Link, Paragraph, Nodes, Root } from 'mdast'
import type { Plugin } from 'unified'

/** F20261008csf1 P1：裸链标记插件。
 *
 *  为什么在 remark（mdast）层做：判定「段落里只有一个链接、无其他文字」需要访问
 *  父段落——react-markdown 传给 components 的 hast 节点没有 .parent 指针（unist
 *  树不回填父指针，parent 只在 visitor 签名里），组件层拿不到段落上下文。本插件
 *  在 mdast 遍历时判定并给 link 写 data.hProperties.dataBareUrl（与 remark-html-card-index
 *  的 fenceIndex 同通道——mdast→hast 只透传 hName/hProperties/hChildren），
 *  UnfurlAwareLink 从 node.properties.dataBareUrl 读。
 *
 *  fail-closed：标记缺失时组件维持普通行内链接（与未接特性前一致），不会误升级。
 */
export const remarkBareLink: Plugin<[], Root> = () => {
  return (tree) => {
    const visit = (node: Nodes) => {
      if (node.type === 'paragraph') {
        const p = node as Paragraph
        // 单子节点且是 link——「裸链段落」的 mdast 形态
        if (p.children.length === 1 && p.children[0].type === 'link') {
          const link = p.children[0] as Link
          // URL 必须与链接文本一致（[label](url) 有作者锚文本，不是裸链）
          const text = link.children
            .map(c => (c.type === 'text' ? c.value : ''))
            .join('')
          if (link.url && text.trim() === link.url && /^https?:\/\//.test(link.url)) {
            link.data = link.data || {}
            link.data.hProperties = { ...(link.data.hProperties || {}), dataBareUrl: link.url }
          }
        }
      }
      if ('children' in node) for (const child of node.children) visit(child)
    }
    visit(tree)
  }
}
