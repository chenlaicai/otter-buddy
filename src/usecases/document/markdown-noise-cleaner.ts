/**
 * F20260803fbit: markdown 噪声清理。
 *
 * body 是原始 markdown，含代码围栏（```）、标题井号（###）、列表符号（1. / -）、
 * HTML 注释、加粗（**）等语法符号。trigram tokenizer 会把这些切成噪声三元组--
 * 搜 "###" 命中所有有标题的文档，搜 "```" 命中所有有代码块的文档，更严重的是
 * BM25 相关性被稀释：搜 createHash 时所有有 ```ts 代码块开头的文档都部分命中。
 *
 * 清理策略：删语法符号，保留代码内容和标题文本（开发者搜函数名要能命中代码块，
 * 搜标题要能命中标题）。
 */

/**
 * 清理 markdown 正文，去除语法噪声保留内容。
 * 纯函数，无 IO。
 */
export function cleanMarkdownForFts(body: string): string {
  return body
    // HTML 注释
    .replace(/<!--[\s\S]*?-->/g, '')
    // 代码围栏开头（保留代码内容，只删围栏行）；F20260803chunk B6: 同时清理 ``` 和 ~~~ 围栏
    // PR审视 S13: 加 ^ {0,3} 缩进限制（与 isFenceLine 一致，CommonMark 最多 3 空格）
    .replace(/^ {0,3}(?:```|~~~)[^\n]*\n/gm, '')
    // 代码围栏结尾
    .replace(/^ {0,3}(?:```|~~~)\s*$/gm, '')
    // 标题井号（保留标题文本）
    .replace(/^#{1,6}\s+/gm, '')
    // 无序列表符号
    .replace(/^\s*[-*+]\s+/gm, '')
    // 有序列表编号
    .replace(/^\s*\d+\.\s+/gm, '')
    // 粗体符号（**text**）
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // 粗体符号（__text__）
    .replace(/__([^_]+)__/g, '$1')
    // 行内代码符号（保留内容）
    .replace(/`([^`]+)`/g, '$1')
    // 链接：保留锚文本，去 URL
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 表格分隔行（如 |---|---|）整行删除
    .replace(/^\|[\s:|-]+\|\s*$/gm, '')
    // 表格单元格：去 | 分隔符
    .replace(/^\|(.+)\|\s*$/gm, (_m, inner: string) => inner.replace(/\|/g, ' ').trim())
    // 引用符号
    .replace(/^\s*>\s?/gm, '')
    // 多空行合并
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
