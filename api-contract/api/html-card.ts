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
