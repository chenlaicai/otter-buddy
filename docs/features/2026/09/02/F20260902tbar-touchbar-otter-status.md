---
id: F20260902tbar
title: 'Touch Bar 海獭状态桥：MTMR 三态常驻显示（睡觉/干活/等你介入）'
doc_type: feature
summary: |
  Touch Bar 状态桥：海獭后端聚合状态 → MTMR items.json → Touch Bar 常驻显示。
  三态判定：🔴等你介入（active 会话 unreadCount>0）、⌨️干活中（activityStatus=processing
  且 lastMessageTs 在 30 分钟新鲜窗口内，防僵尸会话）、💤睡觉（两者皆无），可并存合并显示。
  定位为搭档专属彩蛋（Touch Bar 硬件 2021 年停产），架构上状态源与渲染层分离——
  MTMR 只是 renderer 之一，后续可平滑换菜单栏/Stream Deck 载体。

status: final
change_type: feature
tags: [touchbar, mtmr, status-display, observability, local-tooling]
modules:
  - scripts/otterbar-status.sh
  - scripts/launchd/com.otterbuddy.otterbar-status.plist
capability_test: "n/a: 本机彩蛋工具（非主服务路径），行为由手动验证覆盖（见「手动验证」节）"
created_in_conversation: 31767a2b-4cb0-42d7-99c8-1afec8de6f08
---

# F20260902tbar: Touch Bar 海獭状态桥

## 背景

搭档每次想知道"海獭是否需要我介入"都得点开浏览器切到 web UI。本机是
MacBookPro16,1（2019 款 16"，Intel i9），是最后一波带 Touch Bar 的机型，
TouchBarServer 实测存活。搭档与同事聊天得知"网上有 agent 接入 Touch Bar 玩出花"
（同事用的是付费 BetterTouchTool），遂提出给海獭系统接入。

需求收敛（搭档拍板）：只做两件事——
1. **海獭状态表情**：不用打开窗口，瞄一眼 Touch Bar 就知道海獭在睡觉/干活/等我
2. **需要介入时跳红点**：有未读且等搭档处理时，Touch Bar 上直接可见

明确不做：Touch Bar 按钮触发动作（同事玩法中的快捷键/急停按钮）、BTT 付费路线。

## 方案设计

### 选型：MTMR（免费开源）而非 BetterTouchTool（$10）

- macOS 原生 NSTouchBar API 只允许"自家 app 前台时"渲染 Touch Bar，常驻后台显示
  需要走 Apple 私有接口——这就是 BTT 收费和 MTMR 开源各自封装的那一层
- MTMR（v0.27，2020 年末版）能力恰好覆盖本需求：读 `~/Library/Application Support/MTMR/items.json`
  渲染文字/emoji/颜色，文件变更自动刷新
- 免费路线优先的原则（搭档质疑"$10？"后确认）：先用 MTMR，能力不够再议 BTT

### 三态判定（状态源，单请求）

数据源：`GET /api/conversations`（web 前端本就 5 秒轮询同源数据，零新增后端成本）。
单次请求返回全部 active 会话的 `activityStatus` / `unreadCount` / `lastMessageTs` /
`title`，脚本内一次 jq 聚合出三态：

| 状态 | 判定 | 依据 |
|------|------|------|
| 🔴 等你介入 | active 会话 `unreadCount > 0` | 读没读本身就是时间窗——陈年 awaiting_user 会话（实测 44 个）只要没新未读就不刷屏 |
| ⌨️ 干活中 | `activityStatus == "processing"` 且 `lastMessageTs` 距今 ≤ 1800s | processing 状态可能因异常中断残留（僵尸会话），新鲜度窗口兜底 |
| 💤 睡觉 | 两者皆无 | — |

两态并存时合并显示：`🦦 🔴等你×17 ⌨️干活×5 · 📋 Backlog 排期`（附未读数最多的
会话名前 12 字，提示该去看哪儿）。优先级：等你 > 干活（等你更紧急）。

关键取舍：**不用"行动权是否指向 user"判等你**——初版实现走这条路，实测发现
44 个 active 会话几乎全是历史遗留的 awaiting_user（latest message 一周前），
Touch Bar 会永久显示"等你×44"变成垃圾信息源。改用 unreadCount 后信号噪声比正确。

### 架构：状态源 + 渲染层分离

```
海獭后端 /api/conversations
        │ (curl, 5s 轮询)
        ▼
otterbar-status.sh ── 状态聚合（fetch_state，纯 jq）
        │
        ▼
MTMR items.json ── 渲染层（render_items，纯写文件）
        │
        ▼
Touch Bar 常驻显示
```

脚本内 `fetch_state`（数据判定）与 `render_items`（输出格式）显式分段。Touch Bar
硬件已停产，本设计保证换载体（macOS 菜单栏 app、Stream Deck、桌面 Widget）时只改
render_items 一段，状态判定逻辑零改动。

### 部署：launchd 常驻

`com.otterbuddy.otterbar-status.plist`：RunAtLoad + KeepAlive，开机自启、崩溃拉起。
日志走 `/tmp/otterbar-status.log`（排障用，常态静默）。

## 安装步骤（搭档操作过 1-3，脚本部分由本特性提供）

1. `brew install --cask mtmr`（已完成）
2. 首次启动 MTMR.app 需绕 Gatekeeper：右键打开或「隐私与安全性→仍要打开」（已完成；
   MTMR 2020 年后未续签名，brew cask 下载时被贴隔离标记，`xattr -d com.apple.quarantine` 清除）
3. MTMR 读取 `~/Library/Application Support/MTMR/items.json` 渲染（已验证占位符生效）
4. 安装本特性脚本后：
   ```bash
   mkdir -p ~/Library/LaunchAgents
   cp scripts/launchd/com.otterbuddy.otterbar-status.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.otterbuddy.otterbar-status.plist
   ```

## 手动验证

- **三态渲染**：live API 下输出 `🦦 🔴等你×17 ⌨️干活×5 · 📋 Backlog 排期`（真实聚合结果）
- **后端不可达降级**：API 指向死端口时输出 `🦦 💤 睡觉`（curl -sf 失败 → printf 兜底 0/0），
  不崩溃、不残留旧状态
- **语法/结构**：`bash -n` 通过；plist `plutil -lint` 通过
- 首版踩坑记录：jq 内联 `def` 在单引号 heredoc 中被 shell 转义破坏，改用脚本内
  单引号包裹 jq 程序体解决（测试脚本与主脚本逻辑一致性 diff 验证）

## 影响范围

- 纯新增（2 个文件，均在 `scripts/`），不动主服务任何代码路径
- 后端唯一新增负载：每 5 秒一次 `/api/conversations`（与 web 前端轮询同源同频，可忽略）
- 回滚 = `launchctl unload` + 删文件，零残留

## 已知限制

- MTMR 0.27 是 Intel 原生最后一版，本机（x86_64）适用；换 M 系机器无 Touch Bar，不适用
- "等你介入"以 unreadCount 为准：若搭档在 web 上读了消息但没处理，状态会回落"睡觉"——
  语义是"有你没看过的东西"而非"有事等你决策"，两者在实践中高度重合
- processing 新鲜度窗口 1800s 是估计值，异常中断的会话会在 30 分钟后才回落
