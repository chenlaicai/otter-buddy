---
id: F20260810dsbr
title: restart-dissolve-default-summary
doc_type: feature

summary: |
  修复重启獭生和解散小獭模态框的默认摘要为硬编码文案的用户体验问题。
  原实现中默认值与实际对话内容无关，用户每次都需要手动修改。
  新实现使用空字符串作为默认值，textarea 添加 placeholder 提示用户输入。

causal_links:
  from: []
  to: []

status: development
change_type: bugfix
tags: [web, ux, modal, summary]
modules:
  - web/src/pages/conversation/Modals.tsx
capability_test: "n/a: 前端 UI 默认值修复，无运行时逻辑变更"
---

# F20260810dsbr: 修复重启獭生和解散小獭默认摘要硬编码

## 问题背景

重启獭生（RestartModal）和解散小獭（DissolveModal）的模态框中，默认摘要使用硬编码文案：
- 重启獭生：`之前讨论了 UI 布局方案，但方向有偏差，需要换角度重新分析。`
- 解散小獭：`小獭已完成分析任务，关键结论已记录。`

这些默认值与实际对话内容无关，导致用户每次都需要手动清空并重新输入摘要，影响用户体验。

## 根因分析

React 组件中 `useState` 初始化值使用了固定的中文字符串，而非根据对话上下文动态生成或使用空值。

## 方案

### 核心思路

将默认值改为空字符串，textarea 添加 `placeholder` 提示用户该写什么。

### 为什么用 placeholder 而非动态生成

1. **动态生成复杂**：需要从当前对话历史中提取摘要，涉及 API 调用和状态管理
2. **用户控制权**：摘要应由用户主动填写，而非系统自动生成
3. **一致性**：与同文件中 `NewConvModal` 的 `title` 字段风格保持一致（使用 placeholder）

### 改动范围

仅修改 `web/src/pages/conversation/Modals.tsx`：

1. **DissolveModal**：`useState('小獭已完成分析任务，关键结论已记录。')` → `useState('')`
2. **RestartModal**：`useState('之前讨论了 UI 布局方案，但方向有偏差，需要换角度重新分析。')` → `useState('')`
3. **两个 textarea**：添加 `placeholder` 属性，提示用户输入内容

### 审视发现的边界问题

对抗审视发现：用户不编辑 textarea 直接点确认时，摘要从非空变为空。
- `NewConvModal` 对 `title` 有 `if (summary.trim())` 守卫
- `DissolveModal` 和 `RestartModal` 未做类似守卫

**处置**：已为两个模态框的确认按钮添加 `if (summary.trim())` 守卫，与 `NewConvModal` 风格一致。
用户必须输入非空摘要才能提交，防止意外提交空摘要。

### 设计决策

- **placeholder 文案**：
  - 重启獭生：`简要说明重启原因，将作为新一世的前情摘要`
  - 解散小獭：`简要记录小獭的工作成果和关键结论`
- **防呆守卫**：与 `NewConvModal` 风格一致，用户必须输入非空内容
- **提交后清空**：`setSummary('')` 在确认后重置，避免残留

## Acceptance Test

- [ ] 打开重启獭生模态框，textarea 应为空，placeholder 显示"简要说明重启原因，将作为新一世的前情摘要"
- [ ] 打开解散小獭模态框，textarea 应为空，placeholder 显示"简要记录小獭的工作成果和关键结论"
- [ ] 不输入任何内容直接点确认，按钮应无响应（防呆守卫生效）
- [ ] 输入文字后 placeholder 消失，内容正常显示
- [ ] 确认提交后 textarea 应清空

## PR

- PR #200: https://github.com/chenlaicai/otter-buddy/pull/200
- 审视发现 3 个观察，已全部处置
