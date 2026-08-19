---
id: F20260820val500
title: validation-error-500-to-400
doc_type: feature

summary: |
  修复用例层输入校验错误返回 500 而非 400 的问题。
  将 manage-key-info.ts 中的 plain Error 改为 DomainError(..., "validation"/"not_found"/"conflict")，
  使 http-error.ts 的 DomainErrorKind→HTTP 状态码映射生效。

causal_links:
  from:
    - F20260807fact

status: development
change_type: bugfix
tags: [api, error-handling, validation, conversation]
modules:
  - src/usecases/conversation/manage-key-info.ts
capability_test: n/a
created_in_conversation: bbcfaa33-f036-4493-94de-3faf1c6df6cf
---

# F20260820val500: 输入校验错误 500→400

## 背景与需求

### 问题描述

**Issue #169**：用例层输入校验抛出 plain `Error`，经 `http-error.ts` 兜底后返回 **500**。
外部调用方会把客户端输入错误误判为服务端故障。

项目已有 `DomainError(kind="validation")` → 400 机制（`http-error.ts:16-22`），但用例层校验未使用。

### 影响范围

- 所有 `ManageKeyInfo` 的输入校验场景
- 外部 API 调用方对错误码的误判

## 设计方案

### 错误类型映射

将 `manage-key-info.ts` 中的 `throw new Error(...)` 改为 `throw new DomainError(..., kind)`：

| 错误场景 | 原错误类型 | 新错误类型 | HTTP 状态码 |
|---------|-----------|-----------|------------|
| fact 类型资源必须提供 content | Error | DomainError(validation) | 400 |
| fact 内容超过 500 字符 | Error | DomainError(validation) | 400 |
| 非 fact 类型资源必须提供 url | Error | DomainError(validation) | 400 |
| LinkedResource 不存在 | Error | DomainError(not_found) | 404 |
| 无法归档资源（状态不允许） | Error | DomainError(conflict) | 409 |
| 无法替代资源（状态不允许） | Error | DomainError(conflict) | 409 |
| supersededBy 必填 | Error | DomainError(validation) | 400 |

### http-error.ts 映射

```typescript
const DOMAIN_ERROR_STATUS: Record<DomainErrorKind, number> = {
  not_found: 404,
  conflict: 409,
  validation: 400,
  forbidden: 403,
};
```

### 实现细节

1. 导入 `DomainError` 类
2. 修改 `validateInput` 方法中的 3 个 `throw new Error(...)` 为 `throw new DomainError(..., "validation")`
3. 修改 `supersedeResource`、`archiveResource`、`updateResourceStatus` 方法中的错误为相应的 `DomainError` 类型

## 测试

### 测试结果

- ✅ 所有 106 个测试文件通过（1246 个测试用例）
- ✅ TypeScript 编译通过
- ✅ ESLint 检查通过

### 向后兼容性

- API 行为变化：输入校验错误从 500 变为 400
- 这是**正确的修复**，不是 breaking change
- 外部调用方需要更新错误处理逻辑（如果依赖 500 状态码）

## 取舍与决策

### 错误类型选择

**validation vs not_found vs conflict**：
- 输入校验错误 → `validation`（400）
- 资源不存在 → `not_found`（404）
- 状态转换冲突 → `conflict`（409）

**理由**：遵循 HTTP 语义，让调用方能根据状态码区分错误类型

### 是否需要排查其他用例层文件

**Issue #169 要求**：排查所有用例层 `throw new Error(...)` 的输入校验场景

**本次范围**：仅修复 `manage-key-info.ts`

**后续计划**：
- 其他用例层文件（如 `send-message.ts`、`scheduler-service.ts`）可能有类似问题
- 需要逐一排查，但不在本次 PR 范围内
