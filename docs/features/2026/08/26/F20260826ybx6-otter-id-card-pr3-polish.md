---
id: F20260826ybx6
title: 海獭身份证 PR-3 打磨期：移动端抽屉+EXP动效+时序测试
summary: |
  PR-3 打磨期收尾海獭身份证特性：① Modal 移动端全屏抽屉（<640px，iOS 安全区适配）② EXP 经验条 CSS @keyframes 动画（scaleX + reduced-motion）③ hover 卡 400ms debounce 时序组件级测试（@testing-library/react）。三轮对抗审视收敛。
change_type: feature-update
status: draft
from:
  - F20260825qzwd
capability_test: "n/a: 展示层特性"
created_in_conversation: d1ac0eee-6e02-469e-af1b-dd4d8c30fe3e
---

# 海獭身份证 PR-3 打磨期

## 背景

PR-3 是海獭身份证特性（F20260825qzwd）的第三期，定位为打磨收尾。前两期（PR-1 hover 快览卡、PR-2 聚合端点+装备四槽）已合入 main。

## 目标

- T1: 详情弹窗移动端全屏抽屉（<640px 占满屏幕，保留标题栏和操作按钮）
- T2: EXP 经验条平滑动画（CSS 实现，不引入动画库）
- T3: hover 卡 400ms debounce 时序测试补齐（组件级真测试）

## 方案

### Modal 全屏抽屉

Modal.tsx 新增 `fullScreenOnMobile` 可选属性。窄屏（<640px）时弹窗占满屏幕，样式通过 globals.css 的 `@media` 查询 + `.modal-fs-mobile` 类实现（无 `!important`，无内联 `<style>` 标签）。OtterDetailModal 启用该属性。

关键细节：
- iOS 安全区：footer 添加 `.modal-fs-footer` 类 + `env(safe-area-inset-bottom)`，危险按钮不被系统手势遮挡
- Esc 键和 scrim 点击关闭行为不变

### EXP 条动画

详情弹窗新增经验条（EXP = 发言×1 + 产物×10，上限 100），使用 CSS `@keyframes` + `scaleX(0→1)` + `animation-fill-mode: forwards` 实现。

设计决策：弃用 rAF 双帧 + state 方案（React 18+ 批处理会合并 `setExpWidth(0)` 和 `setExpWidth(pct)`，首帧直接渲染终值，transition 无 0 起点）。CSS `@keyframes` 通过 `transform` 脱离 React state 批处理，弹窗每次打开组件重新挂载触发动画重播。

- `prefers-reduced-motion: reduce` 适配：动画禁用
- exp > 100 时数字后显示「（满格）」溢出说明
- 配套 HelpIcon 说明文案（exp 常量）

### 时序测试

OtterProfileCard.test.tsx 重写为 @testing-library/react 组件级测试：
- 渲染真实 RightPanel（含 OtterParticipantCard debounce 逻辑）
- fireEvent.mouseEnter 触发 hover，vi.advanceTimersByTime 控制时间
- 断言 "Lv." 文本（OtterProfileCard 独有，OtterParticipantCard 不含）

覆盖 5 个场景：
1. 停留 ≥400ms 弹出快览卡
2. 快速滑过（<400ms 移出）不弹出
3. 移出后重新进入需重新计时
4. 停留精确 400ms 触发一次
5. 不重复触发（setTimeout 一次性语义）

## 变更文件

| 文件 | 操作 | 说明 |
|---|---|---|
| web/src/components/Modal.tsx | 修改 | 新增 fullScreenOnMobile 属性 |
| web/src/styles/globals.css | 修改 | 新增 .exp-fill 动画 + .modal-fs-mobile + .modal-fs-footer |
| web/src/pages/conversation/Modals.tsx | 修改 | EXP 条 + 动画 + HelpIcon + fullScreenOnMobile + lint 修复 |
| web/src/components/OtterProfileCard.test.tsx | 修改 | RTL 组件级 debounce 时序测试 |
| docs/features/2026/08/25/F20260825qzwd-otter-id-card.md | 修改 | 迁出 PR-3 实现记录 |

## 验证

- Web 测试：21 文件 / 173 测试全绿
- 后端测试：137 文件 / 1636 测试全绿
- Build：tsc --noEmit + vite build 通过（2692 modules）
- Lint：0 errors, 0 warnings
- CI：pass, MERGEABLE

## 对抗审视决策史

PR-3 经历三轮对抗审视（kimi-面板设计师，异模型），收敛于零新发现。

### 初审（kimi）：3 严重 + 4 建议

| # | 发现 | 级别 | 处置 |
|---|---|---|---|
| S1 | 假时序测试（纯函数未引用实现） | 严重 | 接受：重写为 RTL 组件级测试 |
| S2 | 降级理由不成立（裸 createRoot 问题非 React 19 已知缺陷） | 严重 | 接受：移除错误注释，改用 fireEvent + act |
| S3 | EXP 首开动画被 React 批处理合并 | 严重 | 接受：rAF → CSS @keyframes scaleX |
| A1 | 满格后数值无说明 | 建议 | 接受：exp > 100 显示「（满格）」 |
| A2 | !important 六连 | 建议 | 接受：样式移入 globals.css |
| A3 | iOS 安全区 footer 危险按钮 | 建议 | 接受：env(safe-area-inset-bottom) |
| A4 | PR-2 遗留 lint warning | 建议 | 接受：提取 otterId 变量 |

### Delta-1（kimi）：1 严重 + 1 建议

| # | 发现 | 级别 | 处置 |
|---|---|---|---|
| S4 | build 失败（test mock 缺 conversation prop，TS2741）+ 自报"build 通过"不实 | 严重 | 接受：补 makeConversation mock，push 前真跑 build 附原始输出 |
| A5 | 「精确 400ms 触发一次」测试被裁 | 建议 | 接受：补回 |

### Delta-2（kimi）：零新发现，审视闭环收敛
