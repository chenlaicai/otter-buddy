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
- **白名单校验**（L1 拍板，超出 issue 原文范围的安全加固）：服务端下发的跳转目标未经审计，盲跳会把扫码轮询（含 qrcode/verify_code 参数）乃至 confirmed 后的 bot_token 请求导流到任意域名。仅允许 `weixin.qq.com`/`qq.com` 及其子域；非白名单拒绝切换 + warn + 继续原网关（行为退化为原实现，不新增失败面）
- **校验/使用同源**（审视 S1 修复）：校验对象 = **最终实际使用的 URL 经 `new URL()` 解析后的 hostname**——原实现校验 redirect_host 却使用 baseurl，「合法 host + 恶意 baseurl」组合即绕过；裸串 endsWith 还会放行 `evil.com@weixin.qq.com` 形态（URL 解析后 hostname 其实是官方域，但裸串拼进 https:// 会炸）。统一 URL 解析，非法 URL fail-closed
- **落盘同闸**（审视 S2 修复）：confirmed 响应的 `baseurl` 落盘前过同一白名单（`validateRedirectBase` 共用）——platforms.ts 据此建带 bot_token 的正式 client，Authorization 随行长驻，恶意域=长效凭证泄露；非白名单不落盘（消费端有默认网关回退，不炸登录）
- **URL 选择优先级**：baseurl（完整 URL）优先，redirect_host（纯主机名）兜底拼 `https://`（与初版文档声明相反，以实际使用源为准校验，已修正）
- redirect/baseurl 两者皆缺时 warn 兜底继续原网关

### 机制预算四问（审视 A5）

1. **这机制防什么真实失败？** 服务端下发任意跳转目标 → 扫码参数/bot_token 导流第三方。威胁真实（凭证级），但触发前提 = 官方网关被污染或中间人——概率低、危害高
2. **能不能更简单？** 已是最简形态：一个白名单函数 + 两处调用（switchGateway/confirm），无状态无配置
3. **失败时它自己怎么死？** fail-closed：白名单拒绝 → 行为=原实现（继续原网关/不落盘），warn 落日志可查；不会误杀正常流程（官方域全放行）
4. **它会和谁打架？** 若微信未来启用非 qq.com 域网关，合法 redirect 会被误拒 → 症状=扫码超时 + warn 日志明确指向 host，排查路径短；届时加白名单条目即可

### 测试

`tests/frameworks/weixin/login-flow.test.ts`（新文件，8 用例全 mock fetch 不出网）：
- redirect_host 切换 / baseurl 切换 / 链式 redirect 逐跳切换（审视 A2）
- 非白名单域拒绝：所有轮询留原网关 + warn 副作用
- 审视 S1：合法 redirect_host + 恶意 baseurl 组合不得绕过；官方子域后缀陷阱（weixin.qq.com.evil.com）拒绝
- 审视 S2：confirmed 非白名单 baseurl 不落盘（账号照常落，baseUrl undefined）
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
