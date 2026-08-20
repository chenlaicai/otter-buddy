---
id: F20260820fmtv
title: fmtrelativetime-future-time
doc_type: feature

summary: |
  修复 fmtRelativeTime 对未来时间（负 diff）返回'刚刚'的问题，改为显示绝对时间。
  当前 MPA 模式下 userName 响应式更新非必要，添加技术债注释说明 SPA 模式下的脆弱点。

causal_links:
  from:
    - F20260811a3k7

status: development
change_type: bugfix
tags: [ui, frontend, utils, conversation]
modules:
  - web/src/lib/utils.ts
  - web/src/pages/conversation/index.tsx
capability_test: n/a
created_in_conversation: bbcfaa33-f036-4493-94de-3faf1c6df6cf
---

# F20260820fmtv: fmtRelativeTime 未来时间处理 + userName 技术债注释

## 背景与需求

### 问题描述

**Issue #227**：`fmtRelativeTime` 对未来时间（负 diff）返回'刚刚'，语义不准确。
- 当 `now.getTime() - d.getTime()` 为负数时，`diffSec` 为负数，不会进入 `< 60` 的分支
- 生产环境 `lastMessageTs` 来自数据库，不会出现未来时间，但防御性处理应更准确

**Issue #209**：`userName` 仅 mount 时获取一次，不响应设置页实时变更
- 当前 MPA 模式下 `window.location.href` 整页跳转会重新 mount，行为正确
- 未来改 SPA 路由时，`userName` 不会实时更新，是脆弱点

### 影响范围

- **Issue #227**：低优先级，生产环境不会触发
- **Issue #209**：技术债，当前无实际影响

## 设计方案

### Issue #227 修复方案

在 `fmtRelativeTime` 中增加负 diff 检查：
```typescript
// 未来时间：显示绝对时间（生产环境不会出现，防御性处理）
if (diffSec < 0) return fmtTime(ts)
if (diffSec < 60) return '刚刚'
```

### Issue #209 处理方案

添加技术债注释说明脆弱点：
```typescript
// 获取用户设置（用于消息气泡旁的名称显示）
// NOTE: useEffect([], []) 只在 mount 时执行。当前 MPA 模式下 window.location.href
// 整页跳转会重新 mount，行为正确。未来改 SPA 路由时需改为响应式（如 context/store）。
api.getSettings()
```

## 测试

### 单元测试

新增 `fmtRelativeTime` 未来时间测试用例：
```typescript
it('未来时间显示绝对时间（防御性处理）', () => {
  // 未来时间（负 diff）应显示绝对时间而非'刚刚'
  const ts = '2026-08-11T08:00:00Z' // 1小时后
  expect(fmtRelativeTime(ts)).not.toBe('刚刚')
  // 应该显示绝对时间格式
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  expect(fmtRelativeTime(ts)).toBe(expected)
})
```

### 测试结果

- ✅ 所有 9 个 utils 测试通过
- ✅ TypeScript 编译通过
- ✅ ESLint 检查通过

## 取舍与决策

### Issue #209 的取舍

**选择方案**：添加注释而非实现响应式更新
- **理由**：当前 MPA 模式下无实际问题，实现响应式更新会增加复杂度
- **权衡**：技术债 vs 实现成本，选择记录技术债
- **未来触发条件**：改 SPA 路由时需实现响应式更新

### Issue #227 的取舍

**选择方案**：显示绝对时间而非特定提示
- **理由**：绝对时间是最通用的 fallback，不引入新的 UI 元素
- **权衡**：简洁性 vs 语义精确性，选择简洁性
