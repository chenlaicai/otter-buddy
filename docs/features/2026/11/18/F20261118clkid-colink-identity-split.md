---
title: 回话恒用安装身份——CoLink 写路径与读路径的授权分工口径
id: F20261118clkid
date: 2026-11-18
module: extensions
change_type: feature
status: active
summary: |
  拍板口径：CoLink 回话恒用 App 安装身份（ctx.reply），用户身份只用于读私密内容
  （ctx.colink.user / 平台按 channelVisibility 绑定的 ctx.source.listMessages）。依据是平台分权
  本身：安装授权 scope 为 read-public/receive/write，用户执行授权 scope 只有 read-private（线上 59
  条执行授权全部如此）。因此 #2681 delta8 提出的「回话授权断链」A/B 之争（A 安装令牌绑会话 / B 恢复
  用户令牌）在 0.15→0.28 对齐后已消解，无需改代码；运维含义是安装授权过期只影响读私密，不影响回话。
from:
  - id: F20261118clkpt
    note: 本次口径以 0.28 对齐后的实现为事实基础（回话 ctx.reply、私密读取 ctx.colink.user）
intent:
  problem: "#2681 delta8 独立检视抓出「DM 回话授权断链」四断点，悬置成 A/B 设计拍板（A 安装令牌绑会话 / B 恢复用户令牌），跨会话挂了 14 天；期间 0.15→0.28 对齐（#1917）已把回话路径收敛到 ctx.reply（安装身份），但文档没有写明这条分工，容易被重新当成开放问题"
  expected_effect: "回话/读取的授权分工写进插件 README 与特性文档：写用安装身份、读私密用用户身份（平台契约强制）。后续任何人看到 USER_AUTHORIZATION_UNAVAILABLE 或 reconnect_required，按「读私密授权失效」处理（重新授权该安装），不会误判成回话通路 bug，也不会重新翻 A/B"
  verify_by:
    type: behavior_check
    evidence:
      - "代码锚（origin/main）：extensions/colink-agent-app/src/mention-handler.mjs:30 回话为 ctx.reply（SDK App 客户端，无用户令牌）；src/colink-tools.mjs:252 私密频道读取切 ctx.colink.user"
      - "线上状态实测（ECS /var/lib/colink-agent-app/online/colink-state-v2.enc）：安装授权 scope = messages:read-public messages:receive messages:write；59 条 oauthUserExecutions scope 全部只有 messages:read-private"
      - "真机：2026-11-18 私聊事件 EVENT_ACCEPTED→done 全流程通过（回话用安装身份），同日一个 reconnect_required 安装在处理读私密时失败"
capability_test: "extensions/colink-agent-app/test/colink-tools.test.mjs"
---

# F20261118clkid：回话恒用安装身份——CoLink 写/读授权分工

## 拍板

**回话（写）恒用 App 安装身份；用户身份只用于读私密内容。**

这条来自搭档 2026-11-18 的直判：「既然是对话，那肯定是按照 app 安装身份呀，咋会用用户身份」。

## 为什么之前会冒出 A/B 之争

`#2681`（Agent 私聊入口）实现于 0.15 时代，回话通路曾借「当轮用户授权」的令牌，于是 delta8 独立检视抓出四断点（授权产生 → 携带 → 使用 → 续期），悬置成两案：

- **A 安装令牌绑会话**：用 App 安装身份说话，不依赖用户二次授权；
- **B 恢复用户令牌**：继续用用户身份说话，最小权限但要求授权窗口有效。

## 为什么现在不需要选

平台的分权本来就把两件事切开了，实测口径：

| 授权种类 | scope | 用途 |
| --- | --- | --- |
| 安装授权（`oauthInstallations`） | `messages:read-public` `messages:receive` `messages:write` | 收事件、写回话、读公共 |
| 用户执行授权（`oauthUserExecutions`） | 仅 `messages:read-private` | 读私密（话题/私聊/私密频道） |

线上 59 条用户执行授权**全部**只有 `read-private`，没有一条带写权限——说明写路径从来不是用户令牌的职责。0.15→0.28 对齐（F20261118clkpt）后，回话是 `ctx.reply`（SDK App 客户端），读私密才切 `ctx.colink.user`，代码与平台分工一致，A/B 不再成立。

## 运维含义（这条比结论本身更有用）

安装授权出问题时（`reconnect_required` 状态、`USER_AUTHORIZATION_UNAVAILABLE` 错误）**只影响读私密，不影响回话**。处置方式是让用户重新授权那个安装，而不是去查回话通路。

实测一例：同一安装 `04806b83…` 在 11-16 报过一次 `USER_AUTHORIZATION_UNAVAILABLE`（读私密失败），11-18 一条 `installation_control` 事件把它自动续期成 `ready`；而另一个 `bce97c6c…` 因无 access/refresh 令牌停在 `reconnect_required`，需要用户重新授权。

## 边界

- 本文不改任何代码与运行时行为，只固定口径并留证据锚点；
- 「用户身份不用于写」是平台契约，不是本扩展的取舍——若未来平台提供用户身份的写通路，需重新评估权限面，不能顺手打开。
