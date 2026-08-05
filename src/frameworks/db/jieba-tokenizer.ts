/**
 * jieba 中文分词工具
 *
 * 使用 nodejieba 对中文内容进行分词，支持任意长度中文查询。
 */

import nodejieba from "nodejieba";

/**
 * 对文本进行 jieba 分词
 * @param text 输入文本
 * @returns 分词结果，用空格连接
 */
export function tokenizeWithJieba(text: string): string {
  if (!text) return "";
  const words = nodejieba.cut(text);
  return words.join(" ");
}

/**
 * 对查询词进行 jieba 分词
 * @param query 查询词
 * @returns 分词结果数组
 */
export function tokenizeQuery(query: string): string[] {
  if (!query) return [];
  return nodejieba.cut(query);
}
