---
id: F20260901wxnt
title: 微信 context_token 过期预警：到期前主动提醒，防静默断连
summary: context_token 会话凭证 <2h 失效且过期后出站全灭（预警自己也发不出去）——按对端用户追踪 token 年龄，静默超阈值时在到期窗口内主动发提醒消息，把「静默断连」变成「用户知道怎么救」
change_type: feature
capability_test: "n/a: 方案文档（Design 阶段无代码可测），实现落地时补 tests/frameworks/weixin/polling-channel-warn.test.ts"
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
tags: [weixin, context_token, notify, im]
modules:
  - src/frameworks/weixin/account-store.ts
  - src/frameworks/weixin/polling-channel.ts
  - src/frameworks/config-service.ts
  - src/bootstrap/platforms.ts
---

# 微信 context_token 过期预警：到期前主动提醒，防静默断连

## 背景

搭档原话（2026-09-01，意图锚）：

> context_token快过期时，是否本系统可以发送一条 系统消息 给微信侧，比如说"你很久没说话了，连接要断开了，需要时你可以随便发一条消息重新激活哦"类似于这种。避免静默context_token过期

事实基础（2026-08-31 实测，工作区 weixin-credential-lifecycle.md / fact 59b93573）：

- context_token 是**会话级**凭证，随每条入站消息携带并**换新**（非续期），实测寿命 <2h（14:36 落盘、16:23 出站 ret=-2 失败）
- 过期后 `sendmessage` 全部 ret=-2 "prepare failed"——**预警消息自己也发不出去**，这是协议死路
- 用户再发一条消息即换新恢复；死亡窗口内 agent 的回复静默丢失
- bot_token（账号级）与此无关：getupdates 返回 -14 才是 bot_token 死亡（需重新扫码）；context_token 死亡的解法是「用户随便发条消息」。两种失效解法完全不同

**核心推论：预警必须抢在 token 死亡之前发出。** 方案 = 按「对端用户」追踪 token 年龄 + 静默超阈值时主动提醒 + 发送失败即弃（死 token 无可救援）。

## 目标

- **T1（主）**：token 过期前，向静默超过阈值的微信对端用户发一条预警消息，文案含「随便发一条消息即可重新激活」指引
- **T2（次）**：预警发送失败（ret=-2，token 已死）时留下可观测痕迹（error 日志 + 状态上报），且不 hammering 重试

## 非目标

- **不做 ret=-2 丢失回复的补投递**——token 死亡窗口内 agent 回复丢失，等下一条入站换新后可补投递。独立价值，另立 issue，不混入本 PR
- **不动 /im UI 与 registry 5 态**——`token_stale` 语义保留给 bot_token -14（指引「重新扫码」），不复用于 context_token -2（指引「发条消息」）；混淆两种失效会让 UI 给出错误指引。本次 T2 只做日志层可见
- **不做 TTL 探测/学习**——sendtyping 是否可作无副作用探针属实验性，先不做；阈值靠配置手工调优
- **飞书侧不需要**——WS 长连接无会话凭证时效问题

## 方案设计

### 1. 数据模型：context-tokens.json 格式 v2

现状（src/frameworks/weixin/account-store.ts:84）：`Record<userId, token字符串>`——无时间信息，年龄不可算。

v2：

```jsonc
// data/weixin/<accountId>/context-tokens.json
{
  "<userId>": { "token": "...", "receivedAt": 1725188174000, "warnedAt": 1725191774000 }
}
```

- `receivedAt`：该 token 落盘时刻（= 最近一条入站消息到达时刻）
- `warnedAt`：最近一次预警**发送尝试**时刻（无论成败都记——防死 token 每 35s 被重锤）
- **向后兼容读 v1**：值为字符串 → 迁移为 `{ token, receivedAt: <文件 mtime> }`（mtime 是「最近一次 token 落盘」的可靠代理，8/31 实测已用 mtime 验证过换新时序）；迁移态不回写，下次 save 自然落 v2
- `saveContextToken` 语义升级：写 `receivedAt = now` 且 **清除 warnedAt**（入站换新 token = 用户说话了 = 预警使命完成）
- 消费方声明（#379 ⑥）：`receivedAt`/`warnedAt` 仅由轮询层预警检查读写；`token` 字段消费方不变（gateway adapter resolveContextToken 出站回填，经投影方法读，签名不变）

### 2. 预警检查：轮询循环内嵌（每 ~35s 一 tick）

`WeixinPollingChannel.loop()` 每次迭代开头调 `checkContextTokenExpiry()`（整体 try/catch，不干扰轮询主路径）：

```
for each (userId, entry) in entries:
  age = now - entry.receivedAt
  if age >= afterMs && (entry.warnedAt == null || now - entry.warnedAt >= cooldownMs):
    try:
      await api.sendTextMessage({ toUserId, contextToken: entry.token, text: 预警文案 })
    catch:
      logger.error("context_token 预警发送失败（token 已失效），用户下次发消息即恢复", ...)
    finally:
      accountStore.recordContextTokenWarned(accountId, userId)   // 成败都记
```

- 逐用户独立 try/catch：一个用户失败不阻断其他用户
- 失败不重试：ret=-2 = token 已死，重试必败；记 warnedAt 后冷却期内不再尝试
- **入站自然重置**：`dispatchInbound` 落新 token 时 receivedAt=now、warnedAt 清除（数据模型层已保证）——用户说话即免打扰
- **-14 暂停期自动停摆**：bot_token 死亡期间轮询睡 1h，检查不跑——正确语义（bot_token 死则 sendmessage 必失败，预警无意义）
- 时间注入：poller deps 增加可选 `now?: () => number`（默认 `Date.now`），供测试控制时钟

### 3. 预警文案（硬编码）

```
我们有一阵子没聊天啦～微信的会话凭证快到期了，之后你发的消息我可能会收不到。
随便回我一条（哪怕一个表情）就能续上，需要时随时喊我 🦦
```

贴近搭档原话三要素：很久没说话 + 连接要断开 + 随便发条消息重新激活。系统通知语气，不加 [名字] 前缀（非对话回复）。

### 4. 配置（config.yaml weixin 段，可选）

| key | 默认 | 说明 |
|-----|------|------|
| `contextTokenWarnMinutes` | 60 | 静默多久后发预警。TTL 实测上界 <2h（死亡样本 1h47m），默认 60min 在大概率存活窗口内 |
| `contextTokenWarnCooldownMinutes` | 60 | 同一用户两次预警最小间隔 |

零配置 = 默认启用（60/60）；显式配 `0` 关闭预警。

### 5. 装配（src/bootstrap/platforms.ts）

`startWeixinAccount` 从 weixinConfig 读两个分钟值换算 ms，传入 poller deps：

```ts
contextTokenWarn: { afterMs, cooldownMs }  // minutes * 60_000
```

## 影响范围

- `context-tokens.json` 存储格式 v1→v2（读兼容，无需迁移脚本；外部无其他读写方）
- 轮询循环每 tick 多一次小文件读 + 内存判断（文件 ~百字节，开销可忽略）
- **行为变化**：微信侧用户静默满 1h 会收到一条 bot 主动消息（此前从无主动消息）
- gateway adapter 出站路径零改动（loadContextTokens 对外签名不变，内部投影 v2）
- registry / /im UI 零改动

## 风险与约束

- **TTL 精确值未知**：默认 60min 是基于「<2h 上界 + 1h47m 死亡样本」的工程猜测。若真实 TTL <60min，预警恒失败（无害：一条 error 日志 + warnedAt 止损）。上线路径：默认 60min 跑一段时间，观察「预警发送失败」日志比例，再调阈值
- **风控**：主动消息对微信侧是显性流量（bot_agent 归因可见）。频率受 cooldown 限制（每用户每小时 ≤1 条），量级无害
- **打扰**：对「本来就不想聊」的用户是打扰。缓解：一条即止（说一句话即重置）；文案明确「需要时」
- **mtime 回填精度**：v1 迁移用文件级 mtime，同文件多用户共享同一时间戳（粒度粗）。影响：重启后首批预警时序略偏，不影响正确性；下一次 save 即精确

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 年龄追踪放哪 | account-store 文件 v2 落盘 | poller 内存 Map | 重启不失忆：token 跨重启仍有效但内存年龄丢失 → 要么误报要么漏报；落盘 + mtime 回填让重启后仍能正确算龄 |
| 检查放哪 | 轮询循环每 tick | 独立 scheduler job | poller 已按账号持有 api/store/生命周期；-14 暂停期自动停检查是正确语义；独立 job 需重复装配一套 |
| 预警对象 | 所有有过会话的对端用户 | 仅 partnerUserId | 非搭档的微信用户没有 /im UI 可看，恰是最需要预警的人；搭档自己有 UI 可见状态 |
| T2 可见性 | 仅日志 + 现有 running 态 | registry 新增 context_stale 态 | 两种失效解法不同（-14=重新扫码 vs context 死=发条消息），UI 混淆会误导；等补投递需求落地时一并设计状态展示 |
| 失败重试 | 不重试（记 warnedAt 即弃） | 指数退避重试 | ret=-2 = token 已死，重试必败且每 35s 一次是 hammering |
| 文案 | 硬编码 | 配置化 | 减少配置面；文案迭代走代码有 git 留痕 |
| TTL 阈值 | 可配置 + 保守默认 60min | 探测学习 | sendtyping 探针实验性；先跑默认观察日志再调 |

## 验证

**测试设计**：

1. `tests/frameworks/weixin/account-store-context-age.test.ts`：v1 字符串格式读取（mtime 回填）/ v2 往返 / saveContextToken 保留其他用户条目并清 warnedAt / recordContextTokenWarned
2. `tests/frameworks/weixin/polling-channel-warn.test.ts`（fake clock + mock api）：静默满阈值触发预警 / cooldown 期内抑制 / 入站消息重置（不再预警）/ 发送失败记 warnedAt 不重试（tick 两次只调一次 api）/ 无 token 条目不触发 / 多用户一个失败不阻断
3. config-service：新 key 默认值 / 显式配置 / 0 关闭

**验收标准**：

- A1: 静默满阈值的对端用户在 token 仍存活时收到预警消息（含「发条消息即可恢复」指引）
- A2: 用户回复任意消息后，该用户预警停止（receivedAt 重置）
- A3: token 已死时预警尝试仅发生一次（一条 error 日志，无 35s 重试循环）
- A4: 不配置任何新 key 行为 = 默认启用（60min/60min）；现有入站/出站/状态上报零回归
- A5: v1 存量文件在无人工干预下被正确读取（mtime 回填），首次 save 后自然升级 v2

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/weixin/account-store.ts | M | context-tokens v2 格式（receivedAt/warnedAt + v1 mtime 兼容读）+ recordContextTokenWarned；loadContextTokens 对外签名不变 |
| src/frameworks/weixin/polling-channel.ts | M | loop 每 tick 调 checkContextTokenExpiry；deps 增 contextTokenWarn?/now?；发送失败 error 日志 + warnedAt 止损 |
| src/frameworks/config-service.ts | M | weixin 段新增 contextTokenWarnMinutes / contextTokenWarnCooldownMinutes（含 RawConfig 类型） |
| src/bootstrap/platforms.ts | M | startWeixinAccount 换算并传递 warn 配置进 poller deps |
| tests/frameworks/weixin/account-store-context-age.test.ts | A | 数据模型测试 |
| tests/frameworks/weixin/polling-channel-warn.test.ts | A | 预警触发/抑制/失败路径测试 |
| docs/features/2026/09/01/F20260901wxnt-weixin-context-token-warn.md | A | 本文档 |
