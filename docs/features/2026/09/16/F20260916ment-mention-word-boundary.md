---
id: F20260916ment
title: "@提及词边界规则：对齐 Twitter/Slack 主流做法，消灭「在@功能」误点名"
doc_type: feature

summary: |
  搭档发「系统还当作是在@功能来触发」被误当成点名弹「目标不存在」。修复对齐业界主流
  （Slack 选中绑定 ID / Twitter 词边界规则）：①mention-parser 正则加词边界（@ 前必须是
  行首/空白/中文标点），「在@功能」「xxx@latest」不再被吞；②resolve-send-targets 文本解析
  无有效结果时静默默认派发，不再弹「目标不存在」feedback；③MessageInput 弹层选中即绑定
  otterId 走显式通道，选中后被删除的 @名字 自动失效。既定代价（搭档批准）：「问一下@大獭」
  紧贴前字写法不再算点名，正确写法是 @ 前加空格或从弹层选人。

causal_links:
  from:
    - F20260820i333   # mention-parsing-server-side 本体（issue #333），本特性补其未覆盖场景

change_type: fix
tags: [conversation, mention, parsing, word-boundary, slack-pattern]
modules:
  - src/usecases/conversation/mention-parser.ts
  - src/usecases/conversation/resolve-send-targets.ts
  - web/src/pages/conversation/MessageInput.tsx
  - tests/usecases/conversation/mention-parser.test.ts
  - tests/usecases/conversation/resolve-send-targets.test.ts
  - web/src/pages/conversation/message-input-mention.test.tsx
capability_test: "n/a: 解析规则收窄由单元测试锁定（mention-parser 5 新用例 + resolve-send-targets 3 新用例 + MessageInput 5 新用例）"
created_in_conversation: c1e091b1-7370-42b0-9927-d5ea7717ebf4
---

# @提及词边界规则

## 背景与需求

### 问题现场（搭档报告 2026-09-16）

搭档发「我说话中带有@，但是系统还当作是在@功能来触发，然后还说 目标不存在，发给大獭」。
系统把文中「@功能来触发」整体当成一个獭名，名册查无此獭后弹 feedback：
「@提及的目标不可用：功能来触发（可能已退场或解散），已派给 大獭」。

### 日志实证（data/logs/otter-buddy.log）

近一个月同类误报至少 6 次：

| invalidNames | 场景 |
|---|---|
| `["功能来触发"]` | 本次现场 |
| `["_user_1"]` | 飞书占位符被生吞 |
| `["tencent-weixin/openclaw-weixin-cli@latest"]` | npm 包版本号 |
| `["人的时候"]` | 行文提及 |
| `["我之前调整过","目标",...]` | 行文多个 @ |

### 根因（file:line 锚点）

1. **mention-parser.ts 正则贪吃过界**：`@名字` 只限定后界（空白/中文标点/结尾），
   没有限定 @ 必须处于词首——「在@功能来触发」里 @ 紧贴前字，后随一串中文字
   直到逗号，整段被吞成名字。
2. **resolve-send-targets.ts 把垃圾名字送进 validateTargets**：解析出 invalidNames
   只 logger.info 一笔带过，照样走 validateTargets；全部目标无效时退默认派发 +
   生成「目标不可用」feedback（resolve-send-targets.ts:139-141）。

## 业界主流做法查证（搭档要求「不瞎设计」）

- **主通道（Slack/Discord/Telegram/飞书/企微）**：@ 是结构化实体，输入框选人时绑定
  用户 ID（Slack `<@U0123>`、飞书 `@_user_1` 占位符 + mentions 数组），服务端不反解析文本。
- **降级通道（Twitter/GitHub 自由文本规则）**：@ 必须处于词边界（前面是行首/空白/标点，
  不能紧跟字母数字）——当年就是为了防 `user@example.com` 邮箱被当成提及；
  解析不出来的 @xxx **静默当普通文本**，不给发送者弹报错。

## 方案设计

1. **词边界规则**（两端同口径）：`(?:^|[空白/中文标点])@(名字)(?=[空白/中文标点]|$)`。
   手动边界组实现，不用 lookbehind（兼容任意 JS 运行时）。
2. **无效 @ 静默默认派发**：resolvedIds 为空时不发 feedback；feedback 只保留给
   「显式目标已解散」真异常（validateTargets 显式路径不变）。
3. **Web picker 显式 ID 通道**：弹层选中记录 pickedMentions(Map<名字, ID>)，
   发送时显式 ID 优先；文本里 @名字 被删除的选中项自动失效；手打未走弹层的
   @名字 落入文本解析降级通道。

## 机制识别检查点（修法排序① narrow-fix 论证）

逐项打勾：不新增配置字段/状态生命周期/定时任务/信号类型/持久化存储/决策分支/
跨模块调用路径——pickedMentions 是纯运行时组件 state（销毁随组件），词边界是
既有正则的语义收窄，静默派发是既有默认链路的复用。→ 走修法①，commit 声明
`Modification-Class: narrow-fix`。

## 验证

- mention-parser：31 用例全过（新增 5 词边界回归用例；2 旧用例按搭档批准的
  既定代价改为「紧贴前字不点名」语义）
- resolve-send-targets：3 新用例（无效@静默默认派发、混合有效无效、无 feedback）
- MessageInput：5 新用例（picker 显式 ID、删除失效、手打降级、词边界外、紧贴前字）
- 前端全量 460 用例全过；tsc / eslint 干净

## 已知边界

- 飞书入口的结构化 mentions 数组利用（飞书用户→獭身份映射）是另一个话题，本轮不动。
- 中文行文「问一下@大獭」紧贴前字写法不再点名（既定代价）——弹层选人或 @ 前加空格。
