# web 工具链约定

> 使用时机：design/redesign 产物落地时。两个目标格式，按交付场景选择，不混用。

## 格式选择

| 场景 | 格式 | 约定 |
|---|---|---|
| 通用（交付给人/外部使用） | 独立 HTML 文件 | 单文件自包含（内联 style），无外部依赖，双击可开 |
| 海獭对话卡片 | html-card | 走卡片契约：design token 引用、无外链、≤64KB、otterCard API |

## 独立 HTML 约定

- 单文件自包含：`<style>` 内联，系统字体栈或 web-safe 字体（不外链 Google Fonts——离线打开不缺字）
- 语义标签优先（header/main/section/footer），class 命名表意（.hero-copy 而非 .div1）
- 响应式底线：viewport meta + 基础断点（内容在 375px 宽不失构）
- 交付前浏览器实际打开过一遍（截图或肉眼），不交付未渲染验证的代码

## html-card 约定（海獭对话场景）

- 颜色一律 `var(--otter-*) / var(--teal-*) / var(--caramel-*) / var(--lavender-*) / var(--paper) / var(--ink) / var(--line)` 引用，不硬编码色值——与宿主主题一致是卡片场景的「材质真实」
- 布局用 flex/grid，高度超默认时根元素 `data-height` 声明或 `otterCard.resize()`
- 遵守卡片禁令：无外链、无外部资源、无导航逃逸（细节以当时取到的 get_html_card_contract 为准，契约可能演进）
- 卡片场景的结构选择向「扫读友好」倾斜：折叠态 title 承载结论，展开分层递进

## 字体策略

词典风格条目指定了字体配对意图；落地时：独立 HTML 用系统字体栈模拟（衬线=Georgia/宋体栈，等宽=ui-monospace 栈）；html-card 场景跟随宿主字体环境，用字重/字号/字距表达配对意图。
