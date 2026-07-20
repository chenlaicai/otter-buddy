---
id: F20260720k7m2
title: skill-injection-native
from_ids: [F20260716t2ab]
tags: [agent, skills, sdk, refactor]
modules: [src/frameworks/agent/, src/interface-adapters/skill-adapter/]
doc_kind: spec
status: locked
created_at: 2026-07-20
---

# F20260720k7m2 Skill 注入迁移至 SDK 原生协议

## 背景

### 问题

`PiSessionFactory` 中的 Skill 注入存在两个问题：

1. **绕过 SDK 原生协议**：自定义 `SkillLoader` 手动扫描 `./skills/` 目录，读取 SKILL.md 全文，拼接到消息前缀。pi-coding-agent SDK 已提供完整的 Skill 注入机制（`DefaultResourceLoader` + `additionalSkillPaths`），上层不应重复实现。

2. **重复拼接 bug**：`invoke()` 中 `skillsPrompt` 被加入 `staticPrompt` 后，又在 `buildMessageWithContext()` 调用时再次拼接（`staticPrompt + skillsPrompt`），导致 Skill 内容出现两次。

### SDK 原生机制

pi-coding-agent SDK 提供 `DefaultResourceLoader`，支持：

- `additionalSkillPaths`：指定额外的 Skill 目录，SDK 自动发现 SKILL.md
- `formatSkillsForPrompt()`：将 Skill 格式化为 XML 引用注入系统提示
- Agent 按需通过 `read` 工具加载 Skill 全文（token-efficient）

## 用户意图锚

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "pi coding agent 难道没有直接暴露 skill 注入协议，还需要上层自己去拼接 skill 内容到系统提示词中吗" | SDK 已有原生协议 | 应使用 SDK 的 `DefaultResourceLoader` 而非手动拼接 | 对话 |

## 目标

### T1 — 移除自定义 SkillLoader

删除 `src/interface-adapters/skill-adapter/skill-loader.ts`，该类的功能已被 SDK `DefaultResourceLoader` 完全覆盖。

### T2 — 接入 SDK 原生 Skill 注入

在 `PiSessionFactory.ensurePiCodingAgent()` 中创建 `DefaultResourceLoader`，通过 `additionalSkillPaths` 配置 `./skills` 目录，调用 `reload()` 触发 Skill 发现。所有 `createAgentSession()` 调用传入 `resourceLoader`。

### T3 — 修复重复拼接 bug

移除 `invoke()` 中手动加载 Skill 和拼接 `skillsPrompt` 的逻辑，从 `staticPrompt` 组装中移除 `skillsPrompt`。

## 设计方案

### D1 — ResourceLoader 懒初始化

在 `ensurePiCodingAgent()` 中（SDK 动态 import 之后）创建 `DefaultResourceLoader`：

```typescript
const { DefaultResourceLoader, getAgentDir } = this.piCodingAgent;
this.resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  additionalSkillPaths: [path.resolve(process.cwd(), "skills")],
});
await this.resourceLoader.reload();
```

支持外部注入 `resourceLoader`（构造函数参数），用于测试或自定义配置。

### D2 — invoke() 简化

移除手动 Skill 加载，`staticPrompt` 只包含平台 prompt + Otter prompt：

```typescript
const staticPrompt = [this.platformPrompt, otterPrompt].filter(Boolean).join("\n\n");
```

`createAgentSession()` 传入 `resourceLoader`，SDK 自动将 Skill 注入系统提示。

### D3 — 行为对比

| | 之前 | 之后 |
|---|---|---|
| Skill 发现 | `SkillLoader` 手动扫描目录 | SDK `DefaultResourceLoader` 原生发现 |
| Skill 注入 | 全文拼接到消息前缀 | SDK 生成 XML 引用，agent 按需 `read` |
| Token 效率 | 每次对话携带全文 | 只带 name + description，按需加载 |
| 平台/Otter prompt | 消息前缀（不变） | 消息前缀（不变） |

## 硬约束

1. 不引入新的第三方依赖
2. 不改变平台 prompt 和 Otter prompt 的注入方式（仍为消息前缀）
3. `resourceLoader` 支持外部注入（可测试性）

## 验证

- [x] `tsc --noEmit` 编译通过
- [x] `SkillLoader` 类及相关导入已删除
- [x] `PiSessionFactory` 所有 `createAgentSession()` 调用传入 `resourceLoader`
- [x] `invoke()` 中不再有手动 Skill 加载和拼接逻辑
- [x] `skillsPrompt` 重复拼接 bug 已修复
