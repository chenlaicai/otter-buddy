/** 前后端共享的 html-card 渲染限制常量（单一真相源）
 *  Issue #360：此前 web/src/lib/html-card.ts 与
 *  src/interface-adapters/agent-runtime/tools/tool-helpers.ts 各定义一次，
 *  仅靠注释约定对齐，无编译期保障——漂移会导致后端放行前端降级的卡片数。
 *  本目录两侧均有 @contract 别名（根/web tsconfig、vitest、vite），value 导入可直接解析。 */

/** 单消息卡片预算：第 3 张起前端降级为源码块（不可读），后端 speak 校验同值拒绝 */
export const CARD_MAX_PER_MESSAGE = 2;

/** 单卡体积预算（字节）：F20260916hcel 弹性化——8KB→64KB，由海獭按内容自控。
 *  只限 MAX，无 MIN（搭档拍板：「系统只约束最大，真正大小由海獭按内容决定」） */
export const CARD_MAX_BYTES = 65536;

/** 卡片 schema 版本：F20260916hcel 引入（保留字段，供未来默认状态变化用）。
 *  speak 工具创建含 html-card 的条目时写入 metadata.cardSchemaVersion。
 *  当前所有卡默认 collapsed（搭档 9/16 拍板）。 */
export const CARD_SCHEMA_VERSION = 2;

/** 卡片 iframe 高度区间（像素）。
 *  CARD_MIN_HEIGHT = 展开初始高度（小起步防跳变过量，随后桥 ResizeObserver 自动撑高/缩回到内容真实高度）；
 *  CARD_MAX_HEIGHT = 防失控上限。F20260929ahgt 起高度全自动，agent 无干预通道 */
export const CARD_MIN_HEIGHT = 100;
export const CARD_MAX_HEIGHT = 4000;

/** 卡片预设类库 CSS（F20261006cssp）：高频卡片样式的单一真相源。
 *  前端 HtmlCard 注入 srcdoc（渲染层），契约工具注入类清单（告知层）——两端同源，编译期共享不漂移。
 *  清单由真实卡片重复度聚类定（analyses/card-css-stats.mjs，41 卡实测）：每个类 ≥3 张卡重复才入选，
 *  总量预算 ≤8KB；命名以高频实证为准（.btn/.btns/.bar-row 等），消灭漂移命名（.btn-n/.btn-pri 等 7 种按钮写法并存）。
 *  推荐不强制（搭档拍板：灵活性优先）——预设覆盖不到的自由样式始终可写，卡片内联 <style> 可覆盖预设。
 *  进出机制：进 = ≥3 次真实重复 + 通用性（不绑定单一场景）+ 体积预算内；
 *  出 = 90 天无引用 / 被替代 / 与设计系统冲突，走月度剪枝审视（monthly-prune-review）。 */
export const CARD_PRESET_CLASSES_CSS = `
/* —— 布局容器 —— */
.wrap{padding:10px 14px;font-size:13px;line-height:1.65;color:var(--ink)}
.topic{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.section{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}
.grid{display:grid;gap:10px}
.cols-2{grid-template-columns:1fr 1fr}
.cols-3{grid-template-columns:1fr 1fr 1fr}
.foot{padding:8px 12px;background:var(--otter-50);border-radius:10px;font-size:12px;color:var(--ink-3);margin-top:4px}
.hint{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);color:var(--ink-3);font-size:12px}

/* —— 徽章 / 标签 —— */
.badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;background:var(--otter-100);color:var(--otter-800)}
.badge-ok{background:var(--teal-500);color:#fff}
.badge-warn{background:var(--caramel-400);color:var(--ink)}
.badge-info{background:var(--lavender-400);color:#fff}

/* —— 文本语义 —— */
.k{font-weight:700}
.sec{font-size:12px;color:var(--teal-600);font-weight:700;margin:7px 0 2px}
.mut{color:var(--ink-3);font-size:12px}
.ok{color:var(--teal-600);font-weight:700}
.warn{color:var(--caramel-600);font-weight:600}
.alt{background:var(--otter-50);border-left:3px solid var(--lavender-400);border-radius:0 8px 8px 0;padding:6px 12px;margin:8px 0;font-size:12.5px}

/* —— 键值 / 数据行 —— */
.kv{display:flex;gap:10px;padding:4px 0;font-size:12.5px;border-bottom:1px dashed var(--line)}
.kv .key{width:110px;flex-shrink:0;color:var(--ink-3);font-weight:600}
.kv .val{flex:1}
.meta{font-size:12px;color:var(--ink-3)}

/* —— 条形图 —— */
.bars{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}
.bar-row{display:flex;align-items:center;gap:8px;margin:5px 0}
.bar-name{width:160px;font-size:11.5px;color:var(--ink-3);text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{flex:1;background:var(--otter-50);border-radius:4px;height:16px;position:relative}
.bar-fill{height:100%;border-radius:4px;background:var(--teal-400)}
.bar-fill-warn{background:var(--caramel-400)}
.bar-fill-dim{background:var(--otter-200)}
.bar-val{font-size:11px;font-weight:700;color:var(--ink);width:70px;flex-shrink:0}

/* —— 表格 —— */
.tbl{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}
.tbl th,.tbl td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
.tbl th{background:var(--otter-50)}

/* —— 按钮（交互卡） —— */
.btns{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}
.btn{padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--paper);color:var(--ink);cursor:pointer;font-size:13px;font-weight:600}
.btn-primary{background:var(--teal-500);color:#fff;border-color:var(--teal-600)}

/* —— 卡片头部（简报/汇报用） —— */
.head{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 12px;background:var(--otter-50);border:1px solid var(--line);border-radius:10px;margin-bottom:10px}
.head .title{font-weight:700;font-size:14px}
`;

/** 预设类名清单（给契约工具的告知层）——从 CSS 源机械提取，与渲染层永不漂移。
 *  ⚠️ 边界注记（PR #1318 复核建议 3）：本正则无 `{` 锚，会提取伪类/组合选择器片段（如未来加 .btn:hover 会多提 btn）；
 *  测试侧 card-preset-classes.test.ts 用带 `{` 锚的正则锁「类定义全进清单」——两处故意不同源但需同步维护：
 *  若预设 CSS 未来引入伪类/组合规则，两处提取会分叉、测试会红——那时应统一为共享提取函数（单独立 issue），
 *  当前清单全为单类规则，两处等价 */
export const CARD_PRESET_CLASS_NAMES: string[] = [...new Set([...CARD_PRESET_CLASSES_CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
