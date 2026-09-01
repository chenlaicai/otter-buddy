---
id: F20260901swim
title: "健康面板链泳道时间线：自绘 SVG 五态线尾表达 + 异常筛选 + 链详情抽屉（Issue #649）"
summary: "健康面板重设计 PR3（Issue #649，五期收官）：chains 视图从 slice(0,50) 列表升级为泳道时间线——每链一行，commit 圆点线性映射共享 60 天 x 轴（窗口外老链贴左缘截断标注）；五态线尾表达（active=teal 实线+末端呼吸动画全场唯一动效、stalled=虚化尾+空心圆+停滞天数、regressed=caramel 回卷弧、zombie=otter-300 降饱和+末端 ×、orphan=lavender 悬空空心起点）；异常筛选 chips 视觉反转（异常实心+计数、活跃描边灰显，点选泳道只留命中链）；点行展开详情抽屉（#644 全量 commits+stateReason+docStatus）。列表端点扩展轻量 commits（sha8+date+changeType，全量走 chainDetail）；手写窗口化渲染（零新依赖）。五态元数据收编 chain-state-meta.ts 单一真相源。"
change_type: feature
status: implemented
substatus: active
created_at: 2026-09-01
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
capability_test: "n/a: 纯 UI 渲染与数据透传（无 LLM 行为）。五态视觉契约 21 个 vitest 组件测试 DOM 断言（stalled 虚化/zombie 降饱和/orphan 悬空空心/class+属性级）；筛选行为与窗口化边界（329 链只渲染可视区间）；轻量序列化契约 2 个 API 测试（字段白名单、空数组非 undefined）"
tags: [health, web, ui-redesign, swimlane, chains]
modules: [web/src/pages/health, web/src/api, src/interface-adapters/http/controllers]
intent:
  problem: "链区是名字堆叠列表（slice(0,50)），链是过程数据却无时间表达：51 名之后的链根本看不到（可见性缺口），停滞/僵尸/孤儿等状态只有一枚徽章色，链上 commit 序列（何时引入、何时开始反复修）完全不可见。"
  why_now: "五期工程 PR3 收官。#644 已落 chainDetail 全量端点、#679 已落色彩 token 单一真相源——数据与色彩地基就绪，泳道是观澜视觉方案（ui-redesign-visual-review.md §3.2）定稿的链区最终形态。"
  expected_effect: "搭档扫一眼泳道即知哪条链在走回头路（回卷标记）、哪条该入葬（降饱和+×）、哪条悬空无主（lavender 空心起点）；看异常零成本（实心 chips 点开即命中）；全量链可达（窗口化替代 slice(0,50) 截断）。"
---

## 方案

### 交付 1：泳道时间线 SVG（SwimlaneTimeline.tsx）

- 布局：行高 38px、泳道区 x∈[182, 844]、共享 x 轴 7 档刻度（每 10 天，MM/DD）。
- 时间映射：`[now-60d, now] → [LANE_X0, LANE_X1]` 线性；窗口外截断到左缘 + `data-clipped-start` 截断标注（otter-400 竖线）。
- 节点：commit 实心圆 r=3.5，色按 changeType（BugFix/Experiment=caramel-500，其余=teal-400，`commitNodeColor` 与复发卡同色义）。节点内不放文字，hover `<title>` 给 sha/日期/类型。
- 五态线尾（§3.2 逐条落地，DOM 契约可断言）：
  - `active`：teal-500 实线 + `circle.swim-active-pulse` SMIL 呼吸（r 4→7→4 / opacity 0.5→0.15→0.5，3s）——全场唯一动效（§3.5 动效克制）。
  - `stalled`：`line.swim-stalled-fade`（dasharray 5 4 虚化尾）+ `circle.swim-stalled-end` 空心圆 + `text.swim-stalled-label`「停滞 N 天」（右边界放不下自动翻转到左侧）。
  - `regressed`：`path.swim-regressed-mark` caramel-600 回卷弧（链上最新一个 BugFix 节点位置）。线体保持 teal——它本质仍是进行中的链，深 caramel 只给标记（色彩纪律 1：红只给需要行动的元素）。
  - `zombie`：整线 otter-300 + `g[data-desaturated="1"]` + `path.swim-zombie-end`（otter-400 ×）。
  - `orphan`：`circle.swim-orphan-start` lavender-400 空心起点（fill=none，无入边悬空语义）。
- 虚拟化：手写窗口化——滚动容器 `maxHeight 516px`，只渲染可视区间 ±4 行 overscan；329 链 DOM 行数 ≤ 21。**取舍记录：react-window 等库会引入新依赖（拍板零新增），自绘 SVG 行高固定，窗口化只需 scrollTop→slice 一行算术，实现成本低于引入适配层。**
- 排序：`sortChainsBySeverity`（状态严重度 chainStateRank → 最近活动），与原 chains tab 口径一致，收编为共享导出。

### 交付 2：异常筛选 chips（ChainFilterChips，泳道模块内导出）

- 视觉反转（§3.2）：停滞/回退/僵尸/孤儿四态 chips 用各态色**实心**+计数徽章；「活跃 N」chip 白底描边灰显（常态在筛选语法里降级）；「全部 N」深色激活态。
- 行为：点异常 chip → 泳道只留命中链（`chains.filter(c => c.state === chip)`）；再点或点「全部」恢复。零计数 chip opacity 0.45（仍可见可点——筛选器与数据段的最小可见性保底语义不同）。
- chips 放泳道模块而非 index.tsx：后者 import 时挂载 #root（createRoot 副作用），组件测试无法引用——这也是历史测试只能复制字面量的根因。

### 交付 3：链详情抽屉（ChainDetailDrawer.tsx）

- 点泳道行 → `getRhiChainDetail(featureId)`（#644 端点，AbortController 竞态防护）→ 右侧 480px 抽屉。
- 内容：五态徽章 + docTitle + stateReason + commitCount/bugfixCount/距上次天数 + docStatus + 全量 commit 序列（时间升序：节点色点、sha8、日期、changeType 中文标签、message 首行、filesChanged 前 3 个文件 + 总数 title 全量）。
- 关闭：遮罩点击 / × 按钮；错误态独立显示不空白卡死。

### 交付 0（后端）：chains 列表端点扩展轻量 commits

- `rhi-controller.chains`：每链增加 `commits: [{sha(8), date(ISO), changeType}]`——不带 message/filesChanged 控 payload（329 链 × 均几条 ≈ 60KB 单请求可接受，拍板记录在案）。
- chainDetail 保持全量（含 message/filesChanged）专供抽屉；泳道渲染单请求无瀑布。
- 类型：`RhiChainDTO.commits: RhiChainCommitLiteDTO[]`；`RhiChainDetailDTO` 改为 `Omit<RhiChainDTO,'commits'>` + 全量字段形态（避免 lite/full 数组类型冲突）。

### 结构收编：chain-state-meta.ts（单一真相源）

- `CHAIN_STATE_META`（五态标签/文本色类/图表色）、`chainStateRank`（排序权重）、`ANOMALY_STATES`（筛选序）、`CHANGE_TYPE_LABELS`、`commitNodeColor` 全部从 index.tsx 抽出——泳道/chips/抽屉/ChainStateBar/overview 环形图共用一份色义，跨图表色义锁定（§3.4 纪律 2）。

## 影响范围

- `src/interface-adapters/http/controllers/rhi-controller.ts`：chains 端点 +commits 字段（纯增量，存量消费方不受影响）。
- `web/src/api/client.ts`：DTO 类型扩展。
- `web/src/pages/health/`：新增 SwimlaneTimeline.tsx / ChainDetailDrawer.tsx / chain-state-meta.ts；index.tsx chains tab 重写（列表→泳道+chips+抽屉）。
- 不改链构建/判定逻辑（chain-builder.ts 零改动）；不改历史文档。

## 取舍记录

1. **窗口化 vs 加载更多**：拍板倾向窗口化（零依赖）。实控行高固定 38px 的 SVG 泳道做窗口化只需 scrollTop→start/end 索引换算，比分页的「再点一次」交互成本与状态管理都小。
2. **regressed 线体色**：线体 teal、仅标记深 caramel——若整线 caramel 会与 stalled 混淆且违反「红只给行动点」纪律；issue 只要求「线中段回卷箭头标记」，弧形标记满足语义。
3. **stalled 旁注翻边**：线尾贴右缘时「停滞 N 天」放不下，翻转到空心圆左侧（textAnchor=end）——视觉方案未规定溢出行为，取 diff 最小解。
4. **回卷标记位置**：§3.2 写「线中段」，实现取链上最新 BugFix 节点——它就是「走过回头路」的证据点，比几何中段更有信息量；issue 验收只要求五态可区分。

## 验证

- 后端：`npx vitest run` 208 文件 2599 测试全绿（含 chains 轻量序列化 2 个新用例：字段白名单 sha8/date/changeType、空 commits 序列化为 `[]` 非 undefined）。
- Web：`npx vitest run` 40 文件 352 测试全绿（新增 21：五态行 DOM 契约逐态断言、stalled 三要素、zombie ×/降饱和、orphan 悬空空心、active 呼吸 SMIL、节点色义、x 轴 7 档、截断标注、点击回调、329 链窗口化边界、空态、chips 视觉反转/点选/取消/零计数降透明、排序口径、抽屉渲染/关闭/错误态）。
- 双侧 `tsc --noEmit` 0 错误；`eslint` 0 error。
- 验收对照：五态泳道可视觉区分（DOM 属性级断言）✓；329 链窗口化渲染（DOM 行数 ≤21 断言）✓；异常筛选后泳道只留命中链（filter 行为断言）✓。

## 后续

- 菱形（PR）/方块（merge）节点留 v2：main 上 squash 流 merge commit=0，方节点永远无数据（issue 内合议依据）。
- 泳道节点 hover tooltip 目前用原生 `<title>`，若需要富 tooltip（如文件热区）可后续替换自绘浮层。
