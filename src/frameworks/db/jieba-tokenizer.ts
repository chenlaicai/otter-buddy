/**
 * jieba 中文分词工具
 *
 * 使用 nodejieba 对中文内容进行分词，支持任意长度中文查询。
 */

import nodejieba from "nodejieba";

/** 中文停用词列表 */
const STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
  "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
  "你", "会", "着", "没有", "看", "好", "自己", "这", "他", "她",
  "它", "们", "那", "里", "为", "什么", "怎么", "如何", "可以",
  "以", "及", "与", "或", "但", "而", "把", "被", "让", "给",
  "从", "向", "对", "等", "之", "其", "这个", "那个", "哪个",
  "什么", "怎样", "如何", "为什么", "因为", "所以", "如果",
  "虽然", "但是", "可是", "不过", "然后", "接着", "于是",
]);

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
 * @returns 分词结果数组（已过滤停用词）
 */
export function tokenizeQuery(query: string): string[] {
  if (!query) return [];
  const words = nodejieba.cut(query);
  return words.filter(word => !STOP_WORDS.has(word));
}
