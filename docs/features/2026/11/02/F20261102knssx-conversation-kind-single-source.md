---
id: F20261102knssx
title: ConversationKind 枚举单源化（#1224）：四处平行硬编码收敛 + 三道防线测试锁
change_type: refactor
status: implemented
created: 2026-11-02
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/entities/conversation/conversation.ts
  - src/frameworks/db/conversation/conversation-mapper.ts
  - src/interface-adapters/http/controllers/conversation-controller.ts
  - api-contract/api/conversation.ts
  - web/src/lib/mappers.ts
summary: "#1224（#1201 同型 bug 成因模式）：ConversationKind 合法值多处平行硬编码——新增枚举值漏改任何一处即产生 #1201 形态 bug（web-assistant 上线时 db mapper 白名单漏扩，侧栏分组失灵且 session 检查静默失效）。单源化：entities 落穷尽数组 CONVERSATION_KINDS，类型从数组派生（typeof[number]——数组与类型同一实体，漏进任一侧编译期不可能）；db mapper 白名单、controller query 解析、repo filter、web client options 改经守卫/派生；api-contract DTO kind 联合从 entities 派生（Exclude normal）；前端 LocalConversation.kind 从 DTO 契约派生。新增枚举值只改 entities 一处，全链生效。"
tags: [conversation, entities, type-safety, single-source]
capability_test: "n/a: 纯类型收敛与守卫重构，无 LLM 行为变更"
created_at: 2026-11-02

intent:
  problem: "ConversationKind 枚举四处平行硬编码，新增 kind 需改四处且易漏（#1224 同型 bug 成因）"
  expected_effect: "枚举单源化后新增/检索 kind 只改一处；四处调用点均引用单一导出，跨闸一致性由编译期保证"
  verify_by:
    type: behavior_check
---

# ConversationKind 枚举单源化（#1224）

## 问题

`ConversationKind` 合法值在四处平行硬编码（grep 实拍见 issue #1224）：entities 类型定义（唯一权威源）、db mapper 读侧白名单（#1201 案发地）、controller query 解析白名单、前端 LocalConversation 本地声明。新增枚举值时漏改任何一处即产生 #1201 同型 bug——web-assistant 上线时 mapper 白名单漏扩，侧栏分组认不出 web 助理对话，且 session 检查静默失效 7 天。

## 修复

**单源**：entities 导出穷尽数组，类型从数组派生（1725-r1 严重 1 处置：原 satisfies 子集锁只锁「数组 ⊆ 类型」方向，防 #1201 的有害方向——类型加值漏进数组——零拦截，实验证伪后改派生形态）：

```ts
export const CONVERSATION_KINDS = ["normal", "assistant", "web-assistant"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export function isConversationKind(v: unknown): v is ConversationKind { ... }
```

**收敛面（1725-r1 建议 2 处置后六处）**：

| # | 位置 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | entities | 类型/数组分离硬编码 | 数组单源 + typeof[number] 派生类型 |
| 2 | db mapper | 双值白名单硬编码 | 经守卫 |
| 3 | controller query | 三值白名单硬编码 | 经守卫 |
| 4 | repo filter（usecases） | 三值联合硬编码 | ConversationKind 派生 |
| 5 | web client options | 双值联合硬编码（已落后缺 web-assistant） | DTO 契约派生 + 'normal' |
| contract | api-contract DTO | 本地联合声明 | Exclude<ConversationKind, "normal">（entities import type） |
| 前端 | LocalConversation | 本地联合声明 | NonNullable<DTO['kind']>（契约派生链） |

api-contract 的 DTO `kind?: Exclude<ConversationKind, "normal">` 从 entities import type——web 侧 `@contract/*` 别名解析（web/tsconfig.json:21），前端零本地平行声明。DTO 排除 normal 的既有语义（缺省 = normal 不传输）保持不变。

**排除声明（1725-r1 建议 3）**：`CreateConversationRequestDTO.kind?: "web-assistant"`（api-contract/api/conversation.ts）是开户指令单值（创建 web 助理对话的专用入口参数），非合法值全集声明——不属收敛面。

**新增枚举值的改动面**：entities 的 CONVERSATION_KINDS 数组一处——其余全链（mapper/controller/repo filter/DTO/前端）自动跟随。

## 测试（三道防线）

`tests/entities/conversation-kind.test.ts`：
- 编译期：typeof[number] 派生——数组与类型同一实体，不可分叉（原 satisfies 子集锁被 1725-r1 实验证伪后改派生形态）
- 运行时：数组镜像断言（无重复无遗漏）+ 守卫真值表（合法值全过 / 非法值全拦 / narrowing 生效）

消费点行为锁（既有 + 新增）：
- db mapper：#1201 回归锁已有（F20260929wak1 web-assistant 透传不折叠）
- controller：合法值透传 + 非法值静默忽略已有（tests/api/conversation.test.ts）
- 前端 mapper：新增 3 用例（web-assistant 透传 / 无 kind 缺省 / 类型派生链赋值验证）

## 验证

- 双端 tsc 零错（src + web）
- 全量 425 文件 5608 用例零回归（含 web 测试链）
- eslint / lint:docs / lint:intent 全过（pre-commit 全链 check）

## 影响范围

- 纯类型收敛与守卫重构，运行时行为不变（守卫与原白名单对全部输入等价——真值表锁定）
- 后续 IM 助理多实例或新增对话 kind 时，先改本单源再扩枚举（issue 触发背景的既定路径）

## 设计取舍

- **为何不把 DTO 也做成不 Exclude 的全集**：DTO `kind?` 缺省语义 = normal（不传输），是序列化带宽与既有前端判空逻辑的锚——保持 Exclude 只改派生源，不动序列化行为
- **satisfies → typeof[number] 派生（1725-r1 严重 1）**：satisfies 只锁「数组 ⊆ 类型」子集方向；防 #1201 的有害方向（类型加值漏进数组）零拦截，实验证伪（临时加 "group" 进类型全量 tsc 零错、测试锁全绿）。改数组派生形态后消费点零改动，声明面同步修正——单源不可分叉才成立
- **CreateConversationRequestDTO.kind 单值不收敛（1725-r1 建议 3）**：开户指令参数非合法值全集（只能创 web 助理对话），收敛反会扩语义面；文档补排除声明
- **api-contract 从 src import type 是否破坏契约独立性**：api-contract 是类型真相源的下游消费方而非独立立法者（README「单一真相源」语义本就包含从 entities 派生的正当性）；import type 零运行时产物，web 侧经路径别名消费无构建处理需求（README 准入标准允许）
- **TS 6.0 语法坑留痕**：`as const` 换行接 `satisfies` 会触发解析器三连报错（ASI 视角换行被当语句边界，探针复现）——satisfies 必须同行写
- **机制判定**：类型单源化无新机制引入——机制预算四问不触发

## 关联

- issue #1224；#1201（同型 bug 主案，F20260929wak1 回归锁）；F20260924wast（web-assistant 扩枚举现场）
