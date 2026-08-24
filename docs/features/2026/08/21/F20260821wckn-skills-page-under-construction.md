---
id: F20260821wckn
title: skills-page-under-construction
doc_type: feature

summary: |
  skills 页撤假 CRUD，数据源换 manifest 真实 skill，加整页"建设中"横幅（#366 W0 PR-1）。
  根因：skills 页纯 mock 却提供注册/加载/卸载假交互，误导用户信任（#366 问题 #13）。
  做法：页面收敛为真实数据只读目录 + 显式建设中横幅。

status: development
change_type: fix
tags: [web, cleanup, skills]
modules:
  - web/src/pages/skills/index.tsx
capability_test: "n/a: 纯前端展示层改动（A 类），无 LLM 参与行为"
---

# F20260821wckn: skills 页撤假 CRUD 并加"建设中"标注

本档覆盖 #366 优化第一轮 Wave 0 的 PR-1（skills 页）。

> 原计划 PR-1/2 共用一个薄 F 档；PR-2（lint 接线 CI）开工时已独立立档 **F20260821kgts**（PR #373），本档随之改为单一职责、不再含 Part 结构。

## 背景与需求

### 问题描述

- skills 页（`web/src/pages/skills/index.tsx`）基于 `web/src/mock/data.ts` 纯 mock 数据，却提供完整的注册 Skill / 加载到 Otter / 卸载交互。所有操作只改 React 本地 state，刷新即消失，与真实系统零关联。
- 导航中一个"点了骗人"的页面比没有页面更伤信任（#366 问题 #13）。

### 根因分析

Skill 的 API contract 尚未定义（页面自注 TODO），页面先行按理想交互做了全量 mock，包括写操作。缺的不是样式而是"诚实"：未接入的能力不应呈现为可操作，编造的数据不应呈现为真实。

### 数据实锤

- 原 `web/src/pages/skills/index.tsx:13` 自注 "TODO: API contract not yet defined - all data is mocked"
- `registerSkill`/`loadSkillToOtter`/`unloadSkill` 三函数均只调用 `setSkills` 本地 state + toast 提示"已注册/已加载"
- mock 的 3 个 skill（code-review/deep-research/summary-template）与真实 skill 集合（manifest.yaml 9 个）零重合

## 方案设计

### 技术方案

（PR-1，纯前端展示层），两轮定稿——初版撤假 CRUD + 详情区横幅，经对抗审视后修正：

1. 撤假 CRUD：删除注册 Modal、加载 Modal、卸载按钮及全部相关 state/函数
2. "建设中"横幅提升为**整页顶部**（横跨列表+详情两栏），amber 边框与既有警示样式（memory 页/ChatView）对齐
3. 删除两处"伪真实"区块（审视发现）：前端模板字符串现编的"定义 (Schema + Handler)"、编造的"已分配 Otter"分配关系——mock 数据没有的字段不渲染
4. 数据源从 3 个编造 skill 换为 `prompts/skills/manifest.yaml` 真实 9 skill 静态拷贝（含 manifest 分层：默认搭档/信息层/开发流程链/编排层/元规范），删除零消费者的 `web/src/mock/` 目录

lint 接线 CI（PR-2）见 F20260821kgts。

### 目标

- T1: skills 页不再呈现任何写操作入口
- T2: 页面对"功能建设中"有整页级显式告知
- T3: 页面展示的 skill 清单与系统真实 skill 一致（名称/数量/分组）

### 成功标准

用户进入 skills 页，第一眼即可获知管理功能建设中，页面内容为真实 skill 清单的只读目录，且无任何可触发假成功的操作。

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 无假写操作 | 打开 skills 页，检查全页交互 | 无注册/加载/卸载入口；仅剩列表选择 |
| AT-2 | 建设中告知 | 打开 skills 页查看页面顶部 | 整页级"建设中"横幅，说明管理功能未接入 |
| AT-3 | 只读浏览可用 | 点击左侧列表切换 Skill | 详情正常切换展示（名称/描述） |
| AT-4 | 真实数据 | 对照 prompts/skills/manifest.yaml | 页面 9 个 skill 名称/分组与 manifest 一致 |
| AT-5 | 假数据清除 | 全仓库搜索 mock skill 名 | code-review/deep-research/summary-template 不再出现；web/src/mock/ 已删除 |

### 能力测试映射
| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1~5 | n/a（纯展示层，A 类，见 frontmatter capability_test） |

## 实现细节

### 代码修改

`web/src/pages/skills/index.tsx` 重写为只读页面：
- 删除 `showRegister`/`showLoad`、注册表单 5 组 state、`registerSkill`/`loadSkillToOtter`/`unloadSkill`
- 删除 `Modal`/`ModalButton`/`showToast`/`OTTER_GRADIENT`/`X` 依赖
- 数据源改为页内静态 `skillGroups` 常量（真相源注释指向 manifest.yaml），删除 `web/src/mock/data.ts`
- 新增整页顶部 amber 建设中横幅（lucide `Construction` 图标 + border-amber-300/40）

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| web/src/pages/skills/index.tsx | 修改 | 撤假 CRUD + 真实数据只读目录 + 建设中横幅，250 行 → 125 行 |
| web/src/mock/data.ts | 删除 | 零消费者（skills 页原唯一使用方） |

## 验收结果

### 测试结果

- `npm run build`（tsc --noEmit + vite build）通过
- `npm test`：17 文件 / 143 用例全部通过
- pre-commit 全门禁通过（check / lint:docs / lint-capability-docs / lint-tests）

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 无假写操作 | 证明完成（代码审查 + 构建通过） | ✅ |
| T2 建设中告知 | 证明完成（整页横幅代码落地） | ✅ |
| T3 真实数据 | 证明完成（skillGroups 与 manifest.yaml 逐项一致） | ✅ |

## 对抗审视记录

三路独立 agent 对抗审视（产品信任 / 前端工程质量 / 流程文档合规），用户逐题拍板：

| 发现 | 严重度 | 裁决 | 处置 |
|------|--------|------|------|
| P1 横幅藏详情区，左栏视线起点无标注 | 中 | 采纳：横幅整页化 | 已修 |
| P2 "定义 (Schema+Handler)" 为前端现编（mock 无此字段，handlerRef 不存在） | 中 | 采纳：删除区块 | 已修 |
| P3 "已分配 Otter" 编造分配关系 | 中 | 采纳：删除区块 | 已修 |
| P4 mock 3 skill 与真实 9 skill 零重合 | 低 | 采纳：换 manifest 真实数据 | 已修 |
| P6 空状态"暂无 Skill"死分支语义错误 | 低 | 随数据源重写消除 | 已修 |
| 横幅缺 amber 边框，与既有警示样式不一致 | 低 | 采纳 | 已修 |
| Otter 接口字段死代码（mock/data.ts） | 低 | 随 mock 目录删除消除 | 已修 |
| D1 F 档行数失实（141→实际值） | 中 | 采纳：更正 | 已修 |
| D2 一档跨两 PR 验收表混装 | 中 | 采纳：Part A/B 结构化（后因 PR-2 独立立档 F20260821kgts 而改为单一职责档） | 已修 |
| "lint 声明失实"（质量线提出） | — | 被 third 审视推翻：根 eslint.config.mjs 覆盖 web/src，pre-commit 确实跑 lint | 不改 |
| Modals.tsx 第二份 skill mock 漂移 | 低 | 既有债，不在本 PR 范围（一 PR 一事），留待后续 | 挂起 |

## 设计决策

- **保留只读目录而非清空页面/移除导航入口**：整页横幅承担"诚实"职责后，保留入口让用户能看见系统能力全貌；备选方案（导航 badge、占位页）在审视中讨论后被排除——横幅整页化已满足成功标准。
- **静态拷贝 manifest 而非读文件/加 API**：PR-1 定位纯前端展示层零后端耦合；数据漂移风险由 AT-4 验收 + 未来 lint/契约工作覆盖（PR-2 及契约模块线）。
- **共用薄档计划的放弃**：PR-2 先行独立立档 F20260821kgts，两档各司其职优于跨 PR 混装；本档改为单一职责后与"一 PR 一事 + 一 F 档"纪律对齐。
