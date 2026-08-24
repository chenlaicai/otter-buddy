---
id: F20260824aibd
title: model-identity-injection
doc_type: feature

# 记忆索引
summary: |
  模型身份注入：让海獭知道自己运行在什么模型上，用于对抗性协作场景（开发/检视、编写/审核）选择异模型。
  包含 buildModelIdentity 段构建、pi-session-factory 传递 modelAlias、tool-factory 增强（create_otter 回包模型标签、get_active_participants 返回 modelAlias）、skill 文档更新。

# 因果链路（正向依赖）
causal_links:
  from: [F20260817mrp2, F20260824cfgs]

# 元数据
status: active
change_type: feature
tags: [agent, model-routing, identity, adversarial-collaboration]
modules: [src/frameworks/agent/identity-builder.ts, src/frameworks/agent/pi-session-factory.ts, src/interface-adapters/agent-runtime/tools/tool-factory.ts, src/usecases/ports/agent-tools.ts]

# 时间
created_at: 2026-08-24
created_in_conversation: 132b4bc3-c631-43ce-b596-31ad32e109ff

# 能力测试
capability_test: "tests/frameworks/agent/model-identity.test.ts"
---

# F20260824aibd [agent-runtime] 模型身份注入 + 对抗角色异模型分配

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。进入实现阶段后不得单方面修改，如需变更须通过问题卡片向用户提出并确认。

## 背景 [required]

在多模型路由场景中，海獭需要知道自己运行在什么模型上，以便在对抗性协作（如开发/检视、编写/审核）中选择异模型，发挥不同模型的优势互补价值。

此前，海獭无法感知自己的运行时模型，导致：
1. 对抗性协作时无法主动选择异模型
2. 大獭编排时无法即时获取每只獭的模型分配信息
3. create_otter 回包缺少模型信息，大獭无法即时反馈

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 设计讨论 | 模型身份注入：让海獭知道自己运行在什么模型上 | 目标：感知；场景：对抗性协作 | 需要在身份文案中注入模型信息 |
| UA-2 | 设计讨论 | 对抗性协作场景（开发/检视、编写/审核）选择异模型 | 场景：对抗性协作；行为：选择异模型 | 模型身份用于指导异模型选择 |
| UA-3 | 设计讨论 | 大獭编排时即时获取每只獭的模型分配信息 | 角色：大獭；需求：即时获取 | get_active_participants 需要返回 modelAlias |

## 目标 [required]

### P1 - 模型身份段构建

在 IdentityBuilder 中实现 buildModelIdentity 方法，根据 modelAlias 构建模型身份段，注入到海獭的身份文案中。

具体交付物：
1. buildModelIdentity 方法：根据 modelAlias 从 modelPool 获取模型描述，构建包含模型名称、优势、劣势的身份段
2. 多模型池 + 传入 modelAlias → 包含"你的运行时模型"段
3. 多模型池 + 不传 modelAlias → 使用默认模型
4. 单模型池 → 省略该段（信息量为零）
5. modelAlias 不在池中 → 使用默认模型
6. modelPool 未配置 → 省略该段

### P2 - pi-session-factory 传递 modelAlias

在 PiSessionFactory 中，将 modelAlias 传递给 IdentityBuilder，让海獭知道自己运行在什么模型上。

具体交付物：
1. pi-session-factory 从 getModelAliasForLog 获取 modelAlias
2. 传递给 buildIdentityPrefix 方法

### P3 - tool-factory 增强

增强 tool-factory 中的两个工具：
1. create_otter 回包包含模型标签（modelLabel），让大獭对模型分配有即时反馈
2. get_active_participants 返回 modelAlias，让大獭编排时知道每只獭用什么模型

具体交付物：
1. create_otter 回包格式：`Otter created: ${otter.id} (${otter.name}${modelLabel}). 已就位待命...`
2. get_active_participants 返回格式：`[{ otterId, otterName, status, joinedAtTurnNumber, modelAlias? }]`
3. otterConfigProvider 接口复用（消除内联类型）

### P4 - skill 文档更新

更新 skill 文档，说明模型身份注入的用途和使用方式。

## 非目标 [required]

- 不实现模型路由逻辑（已有 model-pool）
- 不实现模型选择算法（由大獭编排逻辑负责）
- 不修改模型池配置（已有 config.yaml）
- 不实现模型切换功能（只读模型信息）

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 测试覆盖 |
|---|------|----------|----------|
| B1 | 当多模型池 + 传入 modelAlias 时，调用 buildIdentityPrefix | 返回包含"你的运行时模型"段的身份文案 | model-identity.test.ts |
| B2 | 当多模型池 + 不传 modelAlias 时，调用 buildIdentityPrefix | 返回使用默认模型的身份文案 | model-identity.test.ts |
| B3 | 当单模型池时，调用 buildIdentityPrefix | 返回省略模型段的身份文案 | model-identity.test.ts |
| B4 | 当 modelAlias 不在池中时，调用 buildIdentityPrefix | 返回使用默认模型的身份文案 | model-identity.test.ts |
| B5 | 当 modelPool 未配置时，调用 buildIdentityPrefix | 返回省略模型段的身份文案 | model-identity.test.ts |
| B6 | 当创建 Otter 时传入 modelAlias，调用 create_otter | 回包包含模型标签（"模型：xxx"） | create-otter-tool.test.ts |
| B7 | 当创建 Otter 时不传 modelAlias，调用 create_otter | 回包不包含模型标签 | create-otter-tool.test.ts |
| B8 | 当查询活跃参与者时，调用 get_active_participants | 返回包含 modelAlias 的参与者列表 | get-active-participants-tool.test.ts |

## 设计 [required]

### P1 详设

#### buildModelIdentity 方法

```typescript
private buildModelIdentity(alias: string | undefined): string {
  if (!this.modelPool) return '';
  const models = this.modelPool.describeModels();
  // 单模型池省略："你用的是唯一模型"信息量为零，徒增 token
  if (models.length <= 1) return '';

  const target = alias
    ? (models.find(m => m.alias === alias) ?? models.find(m => m.alias === this.modelPool!.getDefaultAlias()))
    : models.find(m => m.alias === this.modelPool!.getDefaultAlias());
  if (!target) return '';

  const strengths = target.strengths?.length ? target.strengths.join('、') : '未指定';
  const weaknesses = target.weaknesses?.length ? target.weaknesses.join('、') : '未指定';

  return [
    '## 你的运行时模型',
    `- 模型：${target.alias}——${target.description ?? '无描述'}`,
    `- 优势：${strengths}`,
    `- 劣势：${weaknesses}`,
    '- 以上信息由系统注入，以此为准判断自己的能力边界，不要凭预训练记忆推测或声称其他模型身份',
    '- 对抗性协作提示：在开发/检视、编写/审核等配对场景中，你与对方使用不同模型。',
    '  训练路径不同 → 思考盲区不同，这正是对抗价值的来源。审视对方产出时，',
    '  优先从你的优势维度切入，不要假设"我想不到的对方也想不到"。',
  ].join('\n');
}
```

#### 取舍说明

1. **为何单模型池省略**：单模型池时，"你用的是唯一模型"信息量为零，徒增 token。省略该段可以减少 prompt 长度，提高效率。
2. **为何 alias 不命中回退默认而非报错**：alias 不在池中可能是配置错误或模型下线，回退到默认模型可以保证功能正常运行，避免因配置问题导致功能失效。报错会中断流程，回退更符合"降级而非失败"的设计哲学。

### P2 详设

pi-session-factory 中，从 getModelAliasForLog 获取 modelAlias，传递给 buildIdentityPrefix：

```typescript
const modelAlias = this.getModelAliasForLog(otterId);
const identityPrefix = await this.identityBuilder.buildIdentityPrefix(otterId, otterType, conversationId, modelAlias);
```

### P3 详设

#### create_otter 回包增强

```typescript
const modelLabel = otter.modelAlias ? `，模型：${otter.modelAlias}` : '';
return textResponse(
  `Otter created: ${otter.id} (${otter.name}${modelLabel}). 已就位待命...`
);
```

#### get_active_participants 增强

```typescript
const result = participants.map(p => {
  const config = ctx.otterConfigProvider?.getConfig(p.otterId);
  return {
    otterId: p.otterId,
    otterName: p.otterName,
    status: p.status,
    joinedAtTurnNumber: p.joinedAtTurnNumber,
    ...(config?.modelAlias ? { modelAlias: config.modelAlias } : {}),
  };
});
```

#### otterConfigProvider 接口复用

引入 OtterConfigProvider 类型，消除内联类型：

```typescript
import type { OtterConfigProvider } from "./otter-config-provider";

export interface ToolContext {
  // ...
  otterConfigProvider?: OtterConfigProvider;
  // ...
}
```

## 验证 [required]

### 单元测试

1. model-identity.test.ts：验证 buildModelIdentity 的 5 种场景
2. create-otter-tool.test.ts：验证 create_otter 回包包含/不包含模型标签
3. get-active-participants-tool.test.ts：验证 get_active_participants 返回 modelAlias

### 集成测试

1. 全量测试通过（1469/1469）
2. tsc --noEmit 通过
3. lint 通过

### 对抗审视

由 reviewer-414（kimi 模型）执行对抗审视，发现 3 个严重问题 + 4 个建议问题，已全部修复。

## 变更记录

- 2026-08-24：初始版本，实现模型身份注入 + 对抗角色异模型分配
