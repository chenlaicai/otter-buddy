import type { Code, Nodes, Root } from 'mdast'
import type { Plugin } from 'unified'

/** remark 插件：按文档序为 html-card 和 html-report 围栏写入 fenceIndex（0 基序号）。
 *  F20260915hrpt：扩展支持 html-report 围栏。
 *  关键（设计文档 R7）：mdast→hast 只透传 hName/hProperties/hChildren 三个保留 key，
 *  任意 data key 静默丢弃——必须走 hProperties 通道（dataFenceIndex → hast properties.dataFenceIndex），
 *  组件从 node.properties.dataFenceIndex 读。覆盖嵌套在 blockquote/list 内的围栏（递归遍历） */
export const remarkHtmlCardIndex: Plugin<[], Root> = () => {
  return (tree) => {
    let index = 0
    const visit = (node: Nodes) => {
      if (node.type === 'code') {
        const lang = (node as Code).lang
        if (lang === 'html-card' || lang === 'html-report') {
          const code = node as Code
          code.data = code.data || {}
          code.data.hProperties = { ...(code.data.hProperties || {}), dataFenceIndex: index, dataFenceType: lang }
          index += 1
        }
      }
      if ('children' in node) for (const child of node.children) visit(child)
    }
    visit(tree)
  }
}
