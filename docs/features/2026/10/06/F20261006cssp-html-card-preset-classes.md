---
id: F20261006cssp
title: html-card 预设类库：前端注入 + 契约告知，样式一致性基建
summary: 高频卡片样式（实测 35 类反复重定义、按钮命名漂移 7 种）沉为前端预注入 CSS——LLM 写卡引用类名不写定义，全系统卡片风格统一 + 省输出 token；推荐不强制，进出有门槛
change_type: feature
capability_test: "n/a: 前端 CSS 注入与契约文本，无 LLM 行为面"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
tags: [html-card, css, preset, contract, web]
modules:
  - api-contract/api/html-card.ts
  - web/src/pages/conversation/HtmlCard.tsx
  - web/src/lib/html-card.ts
  - src/interface-adapters/agent-runtime/tools/html-card-contract-tool.ts
  - tests/interface-adapters/card-preset-classes.test.ts
  - web/src/pages/conversation/HtmlCard.test.tsx
from:
  - F20260724skch
  - F20260728htar
causal_links:
  - "外部洞察（2026-10-06 对话）：QingYunA/answer-me-with-html 的 draft→渲染分工机制（LLM 只写内容，确定性样式下沉渲染器）——本特性取其轻量层"
created_at: "2026-10-06"
intent:
  problem: "每张 html-card 的 <style> 全量手写：41 卡实测样式占 18%、其中高频 35 类每卡重定义（.badge 11 次/.sec 11 次/.btn 9 次），按钮命名漂移出 7 种（.btn/.btn-n/.btn-r/.btn-pri/.btn-sec/.btns/.btn-row）——每次写卡都在重新发明样式，风格不统一，token 白付"
  expected_effect: "LLM 写卡优先引用预设类（class 引用替代 <style> 定义），日常简报卡自定 CSS 占比趋零、风格跨卡统一；定制需求（点名绚丽/自由设计）表达力不受限——内联 <style> 晚于预设解析，同优先级可覆盖"
  verify_by:
    type: behavior_check
---

# html-card 预设类库（F20261006cssp）

## 背景与决策链

**上游**：外部洞察深挖 answer-me-with-html（1473★/5天）——其核心机制是 LLM 只写 Markdown 草稿、本地 CLI 做全部布局（输出 token 省 7-9 倍）。搭档点名「看看如何学习过来」，大獭+kimi 异模型讨论（glm × kimi k3）评估了三条路：

| 方案 | 结论 |
|---|---|
| 完整 DSL（面板化 md→渲染器展开） | **否**——表达力死结（交互卡/自由布局覆盖不了）、body 唯一事实源架构原则冲突、边际收益/复杂度比差 |
| 两级预设（预设类库+片段模板） | 讨论版推荐——后被数据校准砍掉片段模板 |
| 缩小版（仅预设类库） | **拍板执行**（见下） |

**数据校准**（步骤 1 实测，analyses/card-css-stats.mjs，41 卡样本）：
- CSS 样板实际占卡体积 **18%**（讨论时估 30-40%），可被预设覆盖部分折合全卡 **7%**（375B/卡）
- 卡片构成：文字 50% / 标签 32% / style 18%——轻量方案动不了文字与标签
- 最大卡 15KB，离 64KB 上限远——kimi 的「截断重试率」叙事被削弱
- **一致性是真问题**：35 个类 ≥3 张卡重复（.badge/.sec/.btn 领跑），按钮命名 7 种并存

**搭档拍板**（2026-10-06 对话原话锚点）：「ok，我认可，我认为灵活性比节省更优先」——收益定位从 token 大头改为**样式一致性 + 命名规范 + 顺手省 7-15%**；进出机制、推荐不强制（「否则我期望有时候给出好的、绚丽的等定制化需求时，你就搞不定了」）。

## 方案设计

**单一真相源**：预设 CSS 定义在 `api-contract/api/html-card.ts`（CARD_PRESET_CLASSES_CSS 常量）——前端渲染注入与服务端契约告知同源，编译期共享不漂移（Issue #360 模式）。

**渲染层**（web/src/pages/conversation/HtmlCard.tsx）：`buildCardSrcdoc` 在设计 token 之后追加注入 `<style>${CARD_PRESET_CLASSES_CSS}</style>`。注入顺序：CSP meta → token CSS → **预设 CSS** → 桥脚本 → AI HTML——AI 内联 style 晚于预设解析，同 specificity 时作者样式胜出，天然可覆盖（推荐不强制的机制保证）。

**告知层**（src/.../html-card-contract-tool.ts）：get_html_card_contract 新增「预设类库」节——分组类清单 + 使用规则（优先用预设；自定仅当预设不覆盖**或搭档点名要定制**时）。

**转发链**（web/src/lib/html-card.ts）：CARD_PRESET_CLASSES_CSS 加入既有转发导出行（Issue #360 模式——HtmlCard.tsx 从 lib/html-card 导入，lib 从 @contract 转发）。

**清单内容**（35 实测高频类归一为 8 组）：布局容器（.wrap/.topic/.section/.grid/.cols-2/.cols-3/.foot/.hint）、徽章（.badges/.badge + ok/warn/info 变体）、文本语义（.k/.sec/.mut/.ok/.warn/.alt）、键值行（.kv/.meta）、条形图（.bars/.bar-row/.bar-name/.bar-track/.bar-fill + warn/dim 变体/.bar-val）、表格（.tbl）、按钮（.btns/.btn/.btn-primary）、卡头（.head）。漂移命名（.btn-n/.btn-pri 等 7 种）归一到 .btn + 变体模式。

**进出机制**（防死水，搭档 2026-10-06 关切「这个库的进出需要思考好」）：
- 进：三条件全满足——①≥3 张卡真实重复（数据门槛，聚类脚本可复跑）②通用性（不绑定单一场景）③体积预算 ≤8KB（超限先出后进）
- 出：任一触发——90 天无引用 / 被新预设替代 / 与设计系统冲突；走月度剪枝审视（monthly-prune-review 机制层分支）
- 回归锁：6 项一致性测试（card-preset-classes.test.ts）——清单与 CSS 机械一致、契约覆盖每个类名、体积预算、色值只用设计 token

## 验证

- tsc --noEmit 0 错误；eslint 干净
- 根侧 vitest 319 文件 4747 测试全过（含新增 6 项预设一致性测试）
- web 侧 vitest 60 文件 628 测试全过（含新增 HtmlCard 注入测试：srcdoc 含预设 CSS、注入顺序 token→预设→AI HTML、折叠态不注入）
- 转发链回归：lib/html-card.ts 转发行补 CARD_PRESET_CLASSES_CSS（遗漏时运行时 undefined，esbuild 宽松不报错——注入测试专门锁此链路）

## 已知限制与后续

- 预设类不自适应内容：.bar-name 固定 160px 宽，超长场景需作者内联覆盖
- 存量卡片零影响（body 仍是合法 HTML，预设只是新增可用类）；旧卡的手写 style 与预设并存无冲突
- 观察项：后续卡片自定 CSS 占比（预期从 18% 降向 <10%）与预设覆盖率；无重型观察期（缩小版拍板砍掉）
- 雷达简报 prompt 引导切换预设类——待本特性合入后改定时任务 prompt（prompts/scheduled/ 下）时顺带更新
