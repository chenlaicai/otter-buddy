---
id: F20260821w0cl
title: wave0-cleanup
doc_type: feature

summary: |
  W0 清理：skills 页撤假 CRUD 并加"建设中"标注；lint-skills/lint-tool-manifest 接线进 CI（PR-2 追加）。
  根因：skills 页纯 mock 却提供注册/加载/卸载假交互，误导用户信任（#366 问题 #13）。
  做法：页面收敛为只读示意数据 + 显式建设中横幅。

status: development
change_type: fix
tags: [web, cleanup, skills]
modules:
  - web/src/pages/skills/index.tsx
capability_test: "n/a: 纯前端展示层改动（A 类），无 LLM 参与行为"
---

# F20260821w0cl: Wave 0 清理（skills 假页面 + lint 接线）

本档为 #366 优化第一轮 Wave 0 清理类共用薄档，覆盖 PR-1（skills 页）与 PR-2（lint 接线 CI，待追加）。

## 背景与需求

### 问题描述

- skills 页（`web/src/pages/skills/index.tsx`）基于 `web/src/mock/data.ts` 纯 mock 数据，却提供完整的注册 Skill / 加载到 Otter / 卸载交互。所有操作只改 React 本地 state，刷新即消失，与真实系统零关联。
- 导航中一个"点了骗人"的页面比没有页面更伤信任（#366 问题 #13）。

### 根因分析

Skill 的 API contract 尚未定义（页面自注 TODO），页面先行按理想交互做了全量 mock，包括写操作。缺的不是样式而是"诚实"：未接入的能力不应呈现为可操作。

### 数据实锤

- `web/src/pages/skills/index.tsx:13` 自注 "TODO: API contract not yet defined - all data is mocked"
- `registerSkill`/`loadSkillToOtter`/`unloadSkill` 三函数均只调用 `setSkills` 本地 state + toast 提示"已注册/已加载"

## 方案设计

### 技术方案

PR-1（本 PR，纯前端展示层）：

1. 撤假 CRUD：删除注册 Modal、加载 Modal、卸载按钮及全部相关 state/函数（约 130 行）
2. 加"建设中"标注：详情区顶部横幅，明确说明"尚未接入真实系统，当前为示意数据，管理操作暂不可用"
3. 保留只读浏览：列表选择 + 详情查看（描述/定义/已分配 Otter 改为纯展示 chip）

PR-2（后续追加到本档）：lint-skills / lint-tool-manifest 接线进 pre-commit + CI。

### 目标

- T1: skills 页不再呈现任何写操作入口
- T2: 页面对"数据为示意、功能建设中"有显式告知

### 成功标准

用户进入 skills 页，第一眼即可获知该功能建设中、数据非真实，且无任何可触发假成功的操作。

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 无假写操作 | 打开 skills 页，检查全页交互 | 无注册/加载/卸载入口；仅剩列表选择 |
| AT-2 | 建设中告知 | 打开 skills 页查看详情区顶部 | 显示"建设中"横幅，说明为示意数据 |
| AT-3 | 只读浏览可用 | 点击左侧列表切换 Skill | 详情正常切换展示（描述/定义/分配） |

### 能力测试映射
| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1~3 | n/a（纯展示层，A 类，见 frontmatter capability_test） |

## 实现细节

### 代码修改

`web/src/pages/skills/index.tsx` 重写为只读页面：
- 删除 `showRegister`/`showLoad`、注册表单 5 组 state、`registerSkill`/`loadSkillToOtter`/`unloadSkill`
- 删除 `Modal`/`ModalButton`/`showToast`/`OTTER_GRADIENT`/`X` 依赖
- skills 数据源从 `useState` 改为直接引用 mock 常量（不再有本地副本）
- 新增 amber 色建设中横幅（lucide `Construction` 图标）

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| web/src/pages/skills/index.tsx | 修改 | 撤假 CRUD + 建设中标注，250 行 → 141 行 |

## 验收结果

### 测试结果

- `npm run build`（tsc --noEmit + vite build）通过
- `npm test`：17 文件 / 143 用例全部通过

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 无假写操作 | 证明完成（代码审查 + 构建通过） | ✅ |
| T2 建设中告知 | 证明完成（横幅代码落地） | ✅ |

## 设计决策

- 保留 mock 列表的只读展示而非清空页面：导航入口保留上下文，横幅承担"诚实"职责；等 API contract 落地后替换数据源即可（PR-4 契约模块之后的后续工作）。
