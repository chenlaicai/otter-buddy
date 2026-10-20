import type { Link, Nodes, Parent, Root } from 'mdast'
import type { Plugin } from 'unified'

/** F20261020wabt：GFM autolink 全角尾巴修剪（Web 端）。
 *
 *  背景：GFM autolink 对 https?:// 裸链的停止条件只有空白字符和 <——中文、全角
 *  标点（）。：，、）不属于停止集，整段被吸入 link.url（实证：「（http://127.0.0.1:5000）。」
 *  解析出 url="http://127.0.0.1:5000）。」，href 带中文点不开）。IM 出站侧同款问题
 *  已由 F20260920alnk 在投影层根治（trimAutolinkTrailing，文本级修剪），Web 端
 *  当时未接入——本插件是同一判定逻辑在 Web mdast 层的落地。
 *
 *  为什么修在 mdast 节点层而非文本投影层：Web 渲染管线是 ReactMarkdown 直出
 *  hast 组件，没有服务端投影环节；直接在 link 节点上修正 url 与文本，行内链接
 *  与裸链 unfurl（remarkBareLink 依赖 url===text 判定）全链路一并生效，无
 *  round-trip 改写其他语法的风险（对比 alnk 的 position 替换：那里是必须改出站
 *  文本本身，这里是改解析树节点，各取各层）。
 *
 *  判定逻辑与 alnk 的 URL_TRAILING_CHAR 同源：从尾部反向剥离直到命中 RFC 3986
 *  合法尾字符；尾部干净直通零开销。GFM 已正确排除的半角尾巴（如不平衡的 )）
 *  不会出现在 link.url 里，平衡括号属 URL 本体不误剥。
 */

/** URL 尾部合法字符（RFC 3986 pchar/query/fragment 可打印 ASCII 子集，与 alnk 同源） */
const URL_TRAILING_CHAR = /[A-Za-z0-9\-_~.!$&'()*+,;=:@#%/?]$/

function trimUrl(url: string): string {
  let u = url
  while (u.length > 0 && !URL_TRAILING_CHAR.test(u)) u = u.slice(0, -1)
  return u
}

export const remarkAutolinkTrim: Plugin<[], Root> = () => {
  return (tree) => {
    // 第一遍：收集命中链接的修剪动作（含从文本尾部剥下的碎片）。
    // 不在遍历中就地 splice 父级 children——先快照收集，第二遍统一插回。
    const edits: Array<{ parent: Parent; link: Link; fragments: Nodes[] }> = []

    const collect = (node: Nodes, parent?: Parent) => {
      if (node.type === 'link' && parent) {
        const link = node as Link
        if (/^https?:\/\//.test(link.url)) {
          const trimmed = trimUrl(link.url)
          if (trimmed !== link.url) {
            let rest = link.url.slice(trimmed.length) // 被吸入的尾巴，待回接
            link.url = trimmed
            // 链接文本同步修剪：autolink 的文本是 URL 字面量，文本带着被吸入的
            // 尾巴会展示误导（点不开的字符看起来仍属链接）。从文本末段逐段剥离，
            // 剥下的碎片保留顺序，稍后作为普通文本接回链接节点之后（不丢字）。
            const fragments: Nodes[] = []
            while (rest.length > 0 && link.children.length > 0) {
              const last = link.children[link.children.length - 1]
              if (last.type !== 'text') break
              if (last.value.endsWith(rest)) {
                last.value = last.value.slice(0, last.value.length - rest.length)
                if (last.value === '') link.children.pop()
                fragments.unshift({ type: 'text', value: rest })
                rest = ''
              } else if (rest.endsWith(last.value)) {
                fragments.unshift({ type: 'text', value: last.value })
                link.children.pop()
                rest = rest.slice(0, rest.length - last.value.length)
              } else break // 文本与尾巴错位（不应发生）——尽力而为，停剥不破坏
            }
            if (rest.length > 0) fragments.unshift({ type: 'text', value: rest }) // 未剥净兜底
            edits.push({ parent, link, fragments })
          }
        }
      }
      if ('children' in node) {
        const asParent = node as Parent
        for (const child of [...asParent.children]) collect(child, asParent)
      }
    }
    collect(tree)

    // 第二遍：碎片按链接位置接回父级子序列。index 现查不快照——第一遍不 splice
    // （碎片只在第二遍插入），但同 parent 多个命中链接时前一次插入会使后续链接
    // 位置偏移，快照 index 必然失效（alnk 原版用倒序替换防同族问题：
    // message-body-projection.ts「倒序替换，保证前面的 offset 不失效」）。
    // 这里节点引用未变，现查 indexOf 恒准，与倒序等效且更直白。
    for (const { parent, link, fragments } of edits) {
      if (fragments.length === 0) continue
      const index = parent.children.indexOf(link)
      if (index < 0) continue // 链接已不在父级（不应发生）——防御跳过不破坏
      parent.children.splice(index + 1, 0, ...(fragments as Parent['children']))
    }
  }
}
