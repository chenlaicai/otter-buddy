---
id: F20260807usid
title: user-identity-name
doc_type: feature

summary: |
  让海獭知道搭档叫什么。用户显示名存 settings 表，首次 invoke 注入身份段，roster/abort body 等 6 处"搭档"硬编码改为动态读取。零 migration，零 prompt 文件改动。

change_type: feature
status: implemented
tags: [identity, user, settings]
modules:
  - src/usecases/settings/settings-keys.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/http/controllers/settings-controller.ts
  - api-contract/api/settings.ts
  - src/bootstrap/platforms.ts
  - web/src/pages/settings/index.tsx
  - web/src/pages/conversation/index.tsx

capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260807usid: 用户实体身份

## 背景

系统设计哲学是"第一公民是实体不是角色"——每只海獭和用户都是有名字的唯一实体。但当前实现中用户永远被叫"搭档"，6-7 处代码硬编码，无法动态替换。

经对抗审视和业界调研（CAMEL/AutoGen/MetaGPT/OpenClaw），确定最小改动方案：复用 settings 表，不建新表，不改 prompt 文件正文，不改术语库。

## 方案

### 数据层：复用 settings 表

`settings` 键值表存 `user.displayName`。单用户系统不需要单独的 profile 表。

新增常量 `USER_DISPLAY_NAME_KEY` 在 `settings-keys.ts`。

### 身份注入：独立段落

`pi-session-factory.ts` 的 `buildIdentityPrefix` 方法中，如果 settings 有用户名字，追加一段：

```
## 你的搭档
- 名字：{userName}
- 称呼：搭档（你可以用名字称呼 ta）
```

这段跟 self identity 段平行。SYSTEM.md / BIG_OTTER.md / SMALL_OTTER.md 正文保留"搭档"——它描述的是关系定位，不是名字。告诉 LLM 搭档的名字，让它自己判断何时用名字、何时叫搭档。

### 运行时硬编码替换

6 处写死的"搭档"改为读 settings，fallback 到"搭档"：

| 位置 | 改动 |
|------|------|
| `dispatch-chain-engine.ts` buildRoster | 动态名字 |
| `dispatch-chain-engine.ts` buildMessageWithContext | 对话历史标签动态化 |
| `agent-invoker.ts` buildAbortBody | abort body 动态化 |
| `conversation/index.tsx` × 4 | fallback 从"[搭档中断]"改为"[中断]" |

### 前端

settings 页加"你的名字"输入框，调已有 `/api/settings` API。

## 设计决策

1. **复用 settings 表**，不建 user_profile 表。单用户系统，一个键值对够了。
2. **保留 prompt 文件里的"搭档"**。好词不删，问题不是词不好，是写死了。告诉 LLM 名字，让它自己判断。
3. **术语库不动**。"搭档"作为术语概念保持不变，名字注入在 TypeScript 代码层，不在术语层做模板替换。
4. **层级合规**。user-name-resolver 最初放在 frameworks 层，被 lint 拦截（use-cases/interface-adapters 不能导入 frameworks）。改为内联到各层。

## 对抗审视要点

- user_profile 表过度设计 → 改用 settings
- `{user_name}` 放术语库是层污染 → 不动术语库
- prompt 文件去硬编码会让 prompt 变冷 → 保留正文，只加注入段
- roster 已有机制不需要新建 → 只替换硬编码
- scope 从 12+ 文件缩减到 9 个
