/**
 * jieba 中文分词工具
 *
 * 使用 @node-rs/jieba 对中文内容进行分词，支持任意长度中文查询。
 * Lazy initialization：避免模块 import 时因 native addon 加载失败而 crash 整个应用。
 */

import { Jieba } from "@node-rs/jieba";

/** Lazy 初始化 jieba 实例 */
let jiebaInstance: Jieba | null = null;

function getJieba(): Jieba {
  if (!jiebaInstance) {
    jiebaInstance = new Jieba();
  }
  return jiebaInstance;
}

/** 中文停用词列表 */
const STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
  "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
  "你", "会", "着", "没有", "看", "好", "自己", "这", "他", "她",
  "它", "们", "那", "里", "为", "什么", "怎么", "如何", "可以",
  "以", "及", "与", "或", "但", "而", "把", "被", "让", "给",
  "从", "向", "对", "等", "之", "其", "这个", "那个", "哪个",
  "怎样", "为什么", "因为", "所以", "如果",
  "虽然", "但是", "可是", "不过", "然后", "接着", "于是",
]);

/**
 * 对文本进行 jieba 分词
 * @param text 输入文本
 * @returns 分词结果，用空格连接
 */
export function tokenizeWithJieba(text: string, options?: { doubleWrite?: boolean }): string {
  if (!text) return "";
  // F20260902rcp1: 索引侧改 HMM 词典模式（cut(x,true)），产出词典词；
  // doubleWrite=true 时追加全单字序列（cut(x,false) 兼容旧单字查询行为）
  const hmmWords = getJieba().cut(text, true);
  const hmmJoined = hmmWords.join(" ");
  if (!options?.doubleWrite) return hmmJoined;
  const singleChars = getJieba().cut(text, false).join(" ");
  return `${hmmJoined} ${singleChars}`;
}

/**
 * 对查询词进行 jieba 分词
 * @param query 查询词
 * @returns 分词结果数组（已过滤停用词）
 * 注意：如果所有 token 都是停用词，返回原始查询词（避免空结果）
 * F20260902rcp1: 查询侧改 HMM 词典模式——单字模式（cut(x,false)）在
 * @node-rs/jieba 2.x 下无词典参与，中文查询退化为全单字，区分度坍塌（Phase 0 根因1）。
 */
export function tokenizeQuery(query: string): string[] {
  if (!query) return [];
  const words = getJieba().cut(query, true);
  const filtered = words.filter(word => !STOP_WORDS.has(word));
  // 如果过滤后为空，返回原始分词结果（避免查询无结果）
  return filtered.length > 0 ? filtered : words;
}
