/** 前后端共享的 html-card 渲染限制常量（单一真相源）
 *  Issue #360：此前 web/src/lib/html-card.ts 与
 *  src/interface-adapters/agent-runtime/tools/tool-helpers.ts 各定义一次，
 *  仅靠注释约定对齐，无编译期保障——漂移会导致后端放行前端降级的卡片数。
 *  本目录两侧均有 @contract 别名（根/web tsconfig、vitest、vite），value 导入可直接解析。 */

/** 单消息卡片预算：第 3 张起前端降级为源码块（不可读），后端 speak 校验同值拒绝 */
export const CARD_MAX_PER_MESSAGE = 2;

/** 单卡体积预算（字节）：超出时折叠态加体积提示（F20260825hcpg：4KB→8KB，
 *  依据 = LLM 单次响应 max output tokens 内的安全生成预算；中文 UTF-8 每字 3 字节，
 *  4KB 仅容 ~1300 汉字，实际内容容量过低） */
export const CARD_MAX_BYTES = 8192;

// ── html-report 议题汇报卡常量（F20260915hrpt） ──

/** 单张 html-report 体积预算（字节）：议题汇报卡承载完整方案文档，64KB ≈ 21K 汉字 */
export const HTML_REPORT_MAX_BYTES = 65_536;

/** 单消息 html-report 卡数上限：议题汇报是「主产物」，多份议题分多条 speak */
export const HTML_REPORT_MAX_PER_MESSAGE = 1;

/** html-report iframe 初始高度（px） */
export const HTML_REPORT_INITIAL_HEIGHT = 600;

/** html-report iframe 最小高度（px） */
export const HTML_REPORT_MIN_HEIGHT = 400;

/** html-report iframe 最大高度（px） */
export const HTML_REPORT_MAX_HEIGHT = 4000;

/** 模型路由阈值：maxTokens 低于此值的模型输出预算不足以生成完整议题汇报卡 */
export const HTML_REPORT_MIN_MAX_TOKENS = 131_072;
