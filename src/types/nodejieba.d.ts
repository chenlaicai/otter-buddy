declare module "nodejieba" {
  /**
   * 对文本进行分词
   * @param text 输入文本
   * @param useHMM 是否使用 HMM 模型
   * @returns 分词结果数组
   */
  export function cut(text: string, useHMM?: boolean): string[];

  /**
   * 对文本进行分词（搜索引擎模式）
   * @param text 输入文本
   * @param useHMM 是否使用 HMM 模型
   * @returns 分词结果数组
   */
  export function cutForSearch(text: string, useHMM?: boolean): string[];

  /**
   * 对文本进行分词（全模式）
   * @param text 输入文本
   * @returns 分词结果数组
   */
  function cutAll(text: string): string[];

  /**
   * 添加自定义词汇
   * @param word 词汇
   * @param tag 词性
   * @param freq 词频
   */
  function insert(word: string, tag?: string, freq?: number): void;
}
