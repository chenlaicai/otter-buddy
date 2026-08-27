---
id: F20260827mpss
title: MPA 页面清单单一真相源——4 处副本收敛为 1
summary: 同一页面清单散落在 vite.config/server.ts/TopBar/测试 4 处靠人工同步，两次 404 事故。方案：清单落 api-contract/web/pages.ts（现成跨包共享先例），4 个消费方全部改为从清单生成，另加 html 文件集合守卫封住第 5 处漂移点
change_type: refactor
created_in_conversation: 02e892ea-b291-4108-bacf-0d6148790511
---

# F20260827mpss: MPA 页面清单单一真相源

> 状态：**设计稿，待对抗审视 + 搭档拍板**。关联 issue：[#487](https://github.com/…)（[架构] MPA 页面清单单一真相源：4 处副本收敛为 1，根治漏注册）。

## 背景

搭档（chen，issue #487 原文）：

> **同一个「MPA 页面清单」存了 4 份副本**，靠人工纪律同步……两次不是偶然，是结构必然：任何一处清单都可能被遗漏，且无机制拦截。

历史事故：PR #116（7/29 connections 页，加两处漏 server 注册，3 天后 PR #123 侥幸兜住）、PR #444（8/25 health 页，同样漏 server 注册，用户 404）。

### 4 处副本盘点（本次逐一核实，含行号）

| # | 位置 | 形态 | 当前内容 |
|---|------|------|----------|
| 1 | `web/vite.config.ts:12-21` | `build.rollupOptions.input` 对象 | 7 入口：main→index.html（**注意 key 是 main、文件是 index.html**）、conversation、memory、skills、settings、connections、health |
| 2 | `web/src/components/TopBar.tsx:7-16` | `tabs` 数组 | 6 项导航：conversation(href **/**)、memory、skills、health、connections、settings——**无 index 概念**，conversation 项的 href 指向根路径；每项带 icon 组件映射 |
| 3 | `src/bootstrap/server.ts:36-43` | 7 条 `app.get(pattern, serveStatic(...))` | `/`、`/conversation/:id`、`/memory`、`/skills`、`/connections`、`/settings`、`/health`——**conversation 是带参路由** |
| 4 | `tests/bootstrap/server-static-routes.test.ts:43-51` | `it.each` 数组 | 7 项 `[route, page]`，conversation 用 `/conversation/abc` 测试 URL |

**副本间已有微妙漂移**（证明「人工同步」已经在失效）：vite 的 main/index 命名不一致、TopBar 的 conversation↔/ 映射、测试的 :abc 参数填充——4 处各自演化出局部方言，任何「一致性检查」都要先消化这些方言。

**本次盘点发现的第 5 处潜在漂移点**：`web/*.html` 文件集合本身（当前 7 个 html 与清单一致）。收敛后清单成为唯一权威，html 文件若被新增而清单未登记，等于回到原点——需一并设防（见守卫测试）。

另记录一个事实：`web/src/pages/` 下有 7 个目录，其中 `conversation-list` **没有独立 html 入口**（被 index 页复用为组件），不属于 MPA 入口级清单管辖——非目标，仅记录。

### 跨包约束（issue 提出的关键问题）

src（后端）与 web（前端）是两个 tsconfig 域。**现成的双向共享先例：`api-contract/`**——根 tsconfig 有 `@contract/*` → `api-contract/*`，web/tsconfig 有 `@contract/*` → `../api-contract/*`，vite.config 也有对应 alias。页面清单是「前后端共享的 web 应用结构契约」，落 api-contract 语义成立且零新机制。

## 目标

- **T1**：页面清单收敛为单一真相源——新增一个 MPA 页面只改 1 个文件（清单本身），vite 入口 / server 路由 / TopBar 导航 / 测试断言自动同步
- **T2**：现有 7 页面行为不变（PR #478 的全部测试用例继续绿）
- **T3**：清单删除某页面 → server 路由、vite 入口、TopBar 同步消失（issue 验收标准 3）
- **T4**：封住第 5 处漂移点——html 文件集合与清单的一致性有测试守卫

## 非目标

1. 不改变任何页面的路由行为（含 `/health/` 尾斜杠 404 的现状快照）
2. 不处理 SPA 内部路由（hybrid 架构的页内状态，与本清单无关）
3. 不重构 `conversation-list` 等无独立入口的页面组织
4. 不做 i18n（label 常量化即可，多语言是另一维度）

## 方案设计

### 清单文件：`api-contract/web/pages.ts`

```ts
/** MPA 页面单一真相源（issue #487）。
 *  消费方：web/vite.config.ts（构建入口）、src/bootstrap/server.ts（静态路由）、
 *  web/src/components/TopBar.tsx（导航）、tests/bootstrap/server-static-routes.test.ts（防回归）。
 *  新增/删除页面只改本文件。 */
export interface MpaPage {
  /** vite 入口名 = html 文件名（不含 .html） */
  entry: string;
  /** server 路由 pattern（Hono 语法） */
  pattern: string;
  /** TopBar 导航文案 */
  label: string;
  /** TopBar href（缺省 = pattern 去路径参数后的静态形态） */
  nav?: string;
  /** 测试 URL（缺省 = pattern 中 :param 替换为 "abc"） */
  testUrl?: string;
}

export const MPA_PAGES: readonly MpaPage[] = [
  { entry: "index", pattern: "/", label: "对话", nav: "/" },
  { entry: "conversation", pattern: "/conversation/:id", label: "对话详情" },
  { entry: "memory", pattern: "/memory", label: "记忆搜索" },
  { entry: "skills", pattern: "/skills", label: "能力库" },
  { entry: "settings", pattern: "/settings", label: "设置" },
  { entry: "connections", pattern: "/connections", label: "连接" },
  { entry: "health", pattern: "/health", label: "健康面板" },
];
```

字段设计的取舍逻辑：4 个消费方的方言差异（vite 的 main key、TopBar 的 / 映射、测试的 :abc）由**缺省派生规则**消化，特殊形态（index 页）才显式声明——清单主体保持声明式简洁。

**「conversation → index」映射等价性说明（对抗审视后补）**：当前 TopBar 的 `{ key: 'conversation', label: '对话', href: '/' }` 与清单的 `{ entry: 'index', pattern: '/', label: '对话', nav: '/' }` 语义完全等价——TopBar 的 conversation 项指向的一直是 index.html 首页（列表页），而 conversation.html 是详情页（不在 TopBar 导航中，路由 `/conversation/:id`）。收敛后这一方言由清单的 `nav` 字段显式承载，不再依赖读者自行推断。`web/src/pages/conversation-list/` 无独立 html 入口（被 index 页复用为组件），不属清单管辖（见非目标 3）。

### 消费方 1：web/vite.config.ts

```ts
import { MPA_PAGES } from '../api-contract/web/pages'

export default defineConfig(() => ({
  // ...plugins 不变
  build: {
    rollupOptions: {
      input: Object.fromEntries(
        MPA_PAGES.map(p => [p.entry, resolve(__dirname, `${p.entry}.html`)])
      ),
    },
  },
  // ...其余不变
}))
```

要点：入口 key 从方言 main 统一为 index（对 vite 而言 key 只是产物 chunk 名，行为等价）。配置形式上 object 形式同样可以直接 import MPA_PAGES 生成 input（函数式非必需）；本方案选函数式 `defineConfig(() => ...)` 是为留 env/mode 扩展点（如未来按环境裁剪页面），实现时可按团队偏好二选一，不影响清单收敛目标。import 用相对路径（vite config 内 alias 不可用，esbuild 直接转译无碍）。

### 消费方 2：src/bootstrap/server.ts

```ts
import { MPA_PAGES } from "@contract/web/pages";

if (staticRoot !== false) {
  for (const page of MPA_PAGES) {
    app.get(page.pattern, serveStatic({ root: staticRoot, path: `${page.entry}.html` }));
  }
  app.use("/*", serveStatic({ root: staticRoot }));
}
```

7 行手写注册 → 3 行循环。`@contract` alias 在根 tsconfig 已有，src 侧 import api-contract 有大量先例（router 等）。

### 消费方 3：web/src/components/TopBar.tsx

```ts
import { MPA_PAGES } from '@contract/web/pages'

/** icon 是纯视觉实现细节，留在组件层维护（entry → icon 组件映射） */
const ICONS: Record<string, typeof MessageCircle> = {
  index: MessageCircle, memory: Search, skills: Package,
  settings: Settings, connections: Link2, health: Activity,
}

const tabs = MPA_PAGES.map(p => ({
  key: p.entry,
  label: p.label,
  href: p.nav ?? p.pattern.replace(/\/:[^/]+/g, ''),
  icon: ICONS[p.entry] ?? MessageCircle,
}))
```

TopBar 现有 `ViewKey` 类型改为 `MPA_PAGES[number]['entry']`（从清单派生，编译期穷尽）。icon 缺省 fallback `MessageCircle` 使「新增页面忘了配 icon」不编译失败只视觉降级，并在 fallback 分支加 `console.warn` 提示开发者补 icon 映射——配 icon 仍是新增页面时的第 2 个改动点（纯视觉，见取舍表）。

**ViewKey 变更影响面（对抗审视后补，grep 全仓核实）**——entry 从 `'conversation'` 改为 `'index'` 标识首页，不是 TopBar 单文件内改，同步点共 3 类：

1. `web/src/components/AppLayout.tsx:6` 存在一份**手写重复的 union 类型副本**（`activeView: 'conversation' | 'memory' | ...`，未 import ViewKey）——本次改为从清单派生（或 re-export TopBar 的 ViewKey），顺带消除这第 6 处副本
2. 页面字面量传参共 5 处：`conversation-list/index.tsx:110,124,165`（×3 传 `"conversation"`）与 `conversation/index.tsx:1289,1302`（×2 传 `"conversation"`）——全部改为传 `"index"`
3. **详情页高亮行为（实质风险，实现时勿漏）**：当前 conversation 详情页传 `activeView="conversation"` 命中 TopBar 的 conversation tab → 「对话」高亮；方案后 ViewKey 派生自 entry，首页 tab key 变为 `'index'`，若详情页仍传 `'conversation'` 则无 tab 命中 → TopBar 无高亮，**行为回归**。处置：5 处字面量统一改 `'index'`——对话域页面（列表/详情）高亮「对话」tab 是正确行为，改后语义不变

### 消费方 4：tests/bootstrap/server-static-routes.test.ts

```ts
import { MPA_PAGES } from "@frameworks/../api-contract/web/pages"; // 走 @contract alias

// it.each 从清单生成（testUrl 派生规则兜底 :param）
it.each(MPA_PAGES.map(p => [p.testUrl ?? p.pattern.replace(/:[^/]+/g, 'abc'), p.entry]))(...)

// 新增守卫（第 5 处漂移点）：web/*.html 文件集合 === 清单 entry 集合
it("web 目录 html 文件与清单一一对应", () => {
  const htmlFiles = readdirSync(resolve(__dirname, "../../web"))
    .filter(f => f.endsWith(".html")).map(f => f.replace(".html", "")).sort();
  expect(htmlFiles).toEqual([...new Set(MPA_PAGES.map(p => p.entry))].sort());
})
```

原有行为断言（尾斜杠 404 快照、未注册路径 404、staticRoot=false）全部保留——它们测的是路由行为，与清单来源无关。

## 影响范围

- 新增 `api-contract/web/pages.ts`（清单 + 类型，纯数据无依赖）
- `web/vite.config.ts`：对象配置 → 函数式配置，input 生成化
- `src/bootstrap/server.ts`：7 行注册 → 3 行循环
- `web/src/components/TopBar.tsx`：tabs 数组 → 清单映射（icon 表局部保留）
- `tests/bootstrap/server-static-routes.test.ts`：it.each 生成化 + html 集合守卫
- **不影响**：各页面内部实现、API 路由、构建产物形态（input 集合不变）、PR #478 的全部断言语义

## 风险与约束

1. **vite.config.ts 不在任何 tsc 检查域**（根 tsconfig include 只有 src/tests/api-contract，web tsconfig 只有 src/**/*.html）——现状已如此，本方案不恶化：清单文件本身在 api-contract（受根 tsconfig 检查），vite.config 对它的 import 出错会在 `vite build` 时立刻暴露
2. **api-contract 目录语义外延**：从「API 类型契约」扩展到「web 结构契约」——命名上用 `api-contract/web/` 子目录圈定，不与现有 API 契约文件混杂
3. **构建时序**：vite.config import 相对路径源文件（非构建产物），无生成步骤、无时序问题
4. **Hono 路由参数语法耦合**：清单 pattern 用 Hono 的 `:id` 语法，若未来换路由库需改清单——单点修改，可接受

## 不兼容更新

无。构建入口集合、路由行为、导航外观均不变（vite chunk 名 main→index 是内部命名，产物路径不变）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 清单落点 | `api-contract/web/pages.ts` | ① `web/` 顶层 + 根 tsconfig include 扩展；② 独立 `shared/` 包；③ 构建时生成 src 侧文件 | api-contract 是**现成的双向共享先例**（双 tsconfig alias + vite alias 齐备），零新机制；①需改编译域配置且 web/ 顶层文件游离于 web tsconfig；③引入构建时序复杂度 |
| label 进清单 | 进（达成 T1 单文件验收） | 清单只存 route+entry，label 留 TopBar | 后端 import 前端文案的洁癖 vs 验收标准「只改 1 个文件」——取验收；label 属于产品结构而非视觉实现 |
| icon 留 TopBar | 留（视觉关注点） | icon 组件进清单 | 清单是纯数据文件（api-contract 无 react 依赖，引 lucide-react 会污染后端编译域）；新增页面配 icon 是第 2 改动点但纯视觉，fallback 兜底不阻断 |
| index 页特殊形态 | nav 显式声明 | 清单去掉 index、TopBar 硬编码首页项 | index 页有独立 html/路由/测试，理应入清单；方言由缺省派生规则+显式声明消化 |
| #479（CI diff 检查）处置 | 建议关闭 | 改造为「4 处 vs 单一清单」检查 | 检查对象（多处副本）已消失；本方案的 html 集合守卫已覆盖其意图，改造属冗余 |

## 验证

1. **回归**：`server-static-routes.test.ts` 全部用例绿（含改造后的 it.each + 3 个行为断言 + 新增 html 守卫）
2. **T1 演练**（一次性验证后撤掉）：清单加假页 `{ entry: "fake", pattern: "/fake", label: "假页" }` + `web/fake.html` → ① `vite build` 产物含 fake 入口 ② server `/fake` 200 ③ TopBar 出现「假页」导航 ④ **不改其他任何文件**；撤掉清单项+html 后全部同步消失（T3）
3. **守卫自证**：只在 `web/` 加 `orphan.html` 不登记清单 → html 集合守卫红
4. **双域类型检查**：根 tsconfig + web tsconfig `tsc --noEmit` 均 0 error；`vite build` 成功
5. **现有 web 组件测试**：TopBar 若有快照/渲染测试需同步（无直接测试，已核实）

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| api-contract/web/pages.ts | 新增 | MPA_PAGES 清单 + MpaPage 类型 |
| web/vite.config.ts | 修改 | 函数式配置，input 从清单生成 |
| src/bootstrap/server.ts | 修改 | 循环注册替代 7 行手写 |
| web/src/components/TopBar.tsx | 修改 | tabs 从清单派生，icon 映射局部保留（fallback 加 warn） |
| web/src/components/AppLayout.tsx | 修改 | 手写 union 副本改为清单派生（消除第 6 处副本） |
| conversation-list + conversation 页面 | 修改 | 5 处 activeView 字面量 "conversation"→"index"（保高亮行为） |
| tests/bootstrap/server-static-routes.test.ts | 修改 | it.each 生成化 + html 集合守卫 |
| GitHub issue #479 | 关闭（建议） | 检查对象消失，守卫已覆盖意图 |

## 对抗审视记录

### 第一轮（2026-08-27，磨石，mimo 异体）

**焦点**：4 处副本盘点准确性核验、跨包共享机制可行性。两焦点均核验成立（副本内容/方言确认；@contract alias 三处 tsconfig 确认）。0 严重 + 4 建议。

| 发现 | 分级 | 处置（决策树） | 理由 |
|------|------|----------------|------|
| 1. ViewKey 'conversation'→'index' 影响范围未盘点 | 建议 | 接受并扩展：grep 全仓核实后发现比审视报告更广——AppLayout.tsx:6 有一份**手写重复的 union 副本**（第 6 处副本！），页面字面量传参 5 处；且详情页高亮行为是实质风险（不改则 TopBar 无高亮，行为回归）。已补「ViewKey 变更影响面」专节 + 改动范围表扩充 | 审视者方向正确，实际影响面更大；这不是纯类型改动，含行为风险 |
| 2. 函数式 defineConfig 未说明理由 | 建议 | 接受：补一句「object 形式同样可 import 清单，函数式非必需，选它是留 env/mode 扩展点」 | 消除读者疑问；如实声明非必需 |
| 3. icon fallback 需 console.warn | 建议 | 接受：写入方案（fallback 分支加 warn），落在消费方 3 代码示例与改动范围表 | 开发者可发现遗漏 |
| 4. conversation→index 映射等价性未显式声明 | 建议 | 接受：清单设计节补等价性说明段（TopBar conversation 项一直指向 index.html 首页，清单 nav 字段显式承载方言） | 消除读者疑虑 |

> 处置小结：4/4 接受。发现 1 经作者 grep 扩展后揭示：盘点时遗漏了 AppLayout 的类型副本与 5 处字面量同步点——印证了收敛方案本身的价值（副本比肉眼可见的还多一处）。

## 需搭档决策点

1. **清单落点**：推荐 `api-contract/web/pages.ts`（现成跨包先例、零新机制）；若认为 api-contract 语义应严格限于 API 类型，则选独立 `shared/` 目录（需新建双 tsconfig alias，成本略高）
2. **label 是否进清单**：推荐进（满足「新增页面只改 1 个文件」验收）；若坚持后端不碰前端文案，label 留 TopBar，新增页面变 2 处改动
3. **#479 处置**：推荐随本方案落地后关闭；若想保留 CI 级 diff 拦截可改造，但与 html 集合守卫重复
4. **conversation-list 无独立入口的事实**：本次仅记录，是否规范「pages 目录 ↔ 清单」的对应关系属后续清理，不在本方案范围
