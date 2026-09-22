---
id: F20260922wxlg
title: 微信扫码重定向网关切换（#571）+ IM 命令解析器通道无关重命名（#572）
change_type: fix
status: implemented
created: 2026-09-22
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/weixin/login-flow.ts
  - src/frameworks/weixin/api-client.ts
  - src/usecases/im/im-command-parser.ts
summary: "两个 PR #569 审视发现的合并修复：①#571 scaned_but_redirect 原实现在原网关轮询到 5 分钟超时——协议语义要求切 redirect_host 新网关；login-flow 增网关切换 + api-client 增 withBaseUrl 派生，切前过 *.weixin.qq.com/*.qq.com 白名单（扫码轮询含 qrcode/verify_code，盲跳任意域=导流攻击面）。②#572 feishu-command-parser 命名绑定飞书但实质通道无关（微信通道 import 飞书命名），git mv → im-command-parser，三处 import + 测试文件同步。"
tags: [weixin, login, redirect, security, rename, im]
capability_test: tests/frameworks/weixin/login-flow.test.ts
from: [F20260829wxch]
---

# 微信扫码重定向网关切换（#571）+ IM 命令解析器重命名（#572）

两个 PR #569 对抗审视发现的合并修复（同属微信通道跟进，一个行为修复一个语义修正）。

## #571：scaned_but_redirect 网关切换

### 问题

`login-flow.ts` 的类型定义了 `scaned_but_redirect` 状态及 `redirect_host`/`baseurl` 字段，但 `handleNonConfirmed` 的 default 分支将其视为「继续轮询」——协议语义要求切换到 `redirect_host` 指向的新网关重试，原实现会在原网关轮询直到 5 分钟超时，redirect 场景下扫码永远等不到 confirmed。

### 方案与取舍

- **切换点放在 login-flow 而非 session-manager**：switch 后 `this.deps.api` 派生新网关 client，本实例后续轮询自动走新网关；session-manager/CLI 无感
- **api-client 增 `withBaseUrl`** 派生同配置（token/logger 随实例）新 client，不改原 client 可变状态——避免共享 client 被中途换底座影响其他调用方
- **白名单校验**（L1 拍板，超出 issue 原文范围的安全加固）：服务端下发的 `redirect_host` 未经审计，盲跳会把扫码轮询（含 qrcode/verify_code 参数）导流到任意域名。仅允许 `weixin.qq.com`/`qq.com` 及其子域；非白名单拒绝切换 + warn 告警 + 继续原网关轮询（行为退化为原实现，不新增失败面）
- `redirect_host`（纯主机名）优先于 `baseurl`（完整 URL）；两者皆缺时 warn 兜底继续原网关

### 测试

`tests/frameworks/weixin/login-flow.test.ts`（新文件，4 用例全 mock fetch 不出网）：
- redirect_host 切换：前两轮原网关 → redirect 后轮询打到 `szshort.weixin.qq.com` → confirmed 落盘
- baseurl 形式切换
- 非白名单域（evil.example.com）拒绝切换：所有轮询留原网关 + warn 副作用
- redirect 缺 host/baseurl：保持原网关 + warn 兜底

## #572：feishu-command-parser → im-command-parser

命令集（/list /in /out /history /help）实质通道无关，命名绑定飞书导致微信通道 import 飞书命名、语义误导维护者。`git mv` 保留历史，三处 import（feishu command-dispatcher / weixin message-processor / 测试文件）同步更新。命令集逐项过一遍无飞书特有命令，无需拆分通道特化层。docs 下 4 篇历史 F 文档的旧文件名引用不改（死纹身，见 #835）。

## 验证

- tsc --noEmit 0 错
- 全量单测 273 文件 3740 用例全过（含新 4 用例）
- lint 0 error（存量 8 warning 与本改动无关）

## 影响范围

- 微信扫码登录：redirect 场景从「必超时」变为「可完成」；非 redirect 场景行为不变
- 白名单拒绝时行为 = 原实现（继续原网关），无新增失败面
- 重命名纯机械，无行为变化

## 关联

- issue #571（PR #569 审视建议发现 4）、#572（审视建议发现 5）
- #564 tracker（微信通道接入）
- F20260829wxch（微信通道核心）
