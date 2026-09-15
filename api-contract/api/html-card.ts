/** 前后端共享的 html-card 渲染限制常量（单一真相源）
 *  Issue #360：此前 web/src/lib/html-card.ts 与
 *  src/interface-adapters/agent-runtime/tools/tool-helpers.ts 各定义一次，
 *  仅靠注释约定对齐，无编译期保障——漂移会导致后端放行前端降级的卡片数。
 *  本目录两侧均有 @contract 别名（根/web tsconfig、vitest、vite），value 导入可直接解析。 */

/** 单消息卡片预算：第 3 张起前端降级为源码块（不可读），后端 speak 校验同值拒绝 */
export const CARD_MAX_PER_MESSAGE = 2;

/** 单卡体积预算（字节）：F20260915hcel 弹性化——8KB→64KB，由海獭按内容自控。
 *  只限 MAX，无 MIN（搭档拍板：「系统只约束最大，真正大小由海獭按内容决定」） */
export const CARD_MAX_BYTES = 65536;

/** 卡片 schema 版本：F20260915hcel 引入，用于区分新卡（默认展开）与老卡（保持折叠）。
 *  speak 工具创建含 html-card 的条目时写入 metadata.cardSchemaVersion，
 *  前端读此字段：≥2 → 默认 expanded；缺失 → 默认 collapsed */
export const CARD_SCHEMA_VERSION = 2;

/** 卡片 iframe 高度 clamp 区间（像素）：海獭可通过 data-height 属性或 otterCard.resize() 自定 */
export const CARD_MIN_HEIGHT = 100;
export const CARD_MAX_HEIGHT = 4000;
