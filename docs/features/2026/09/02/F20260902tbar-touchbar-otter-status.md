---
id: F20260902tbar
title: 'Touch Bar 海獭状态桥：MTMR 三态常驻显示（睡觉/干活/等你介入）'
doc_type: feature
summary: |
  Touch Bar 状态桥 v2：海獭后端 → status-core 聚合 → Display Model JSON（稳定契约）→
  renderer-mtmr 渲染到 MTMR。四态显示：🔴等你介入（unreadCount>0）、⌨️干活中
  （processing+30 分钟新鲜窗）、💤睡觉、🖤系统离线（后端不可达显式态，不降级成睡觉）。
  架构解耦：系统侧与渲染层分离，未来切自研 Swift 渲染端（DFR 私有接口）只换 renderer。
  MTMR 无局部刷新接口，字符动画=整条闪烁不可用，真动画归自研课题（见关联 issue）。

status: final
change_type: feature
tags: [touchbar, mtmr, status-display, observability, local-tooling]
modules:
  - scripts/otterbar/status-core.sh
  - scripts/otterbar/renderer-mtmr.sh
  - scripts/launchd/com.otterbuddy.otterbar-core.plist
  - scripts/launchd/com.otterbuddy.otterbar-renderer-mtmr.plist
capability_test: "n/a: 本机彩蛋工具（非主服务路径），行为由手动验证覆盖（见「手动验证」节）"
created_in_conversation: 31767a2b-4cb0-42d7-99c8-1afec8de6f08
---

# F20260902tbar: Touch Bar 海獭状态桥

## 背景

搭档每次想知道"海獭是否需要我介入"都得点开浏览器切到 web UI。本机是
MacBookPro16,1（2019 款 16"，Intel i9），是最后一波带 Touch Bar 的机型，
TouchBarServer 实测存活。需求收敛（搭档两轮拍板）：

1. **海獭状态表情**：不用打开窗口，瞄一眼 Touch Bar 就知道海獭在睡觉/干活/等我
2. **需要介入时跳红点**：有未读且等搭档处理时，Touch Bar 上直接可见
3. **v2 追加**（搭档反馈五点）：系统离线显式态、数字可视化去简陋、还原系统控件
   （Esc/音量/亮度）、架构解耦（后续切自研 Swift 渲染端，展示内容由系统传递）

明确不做：Touch Bar 按钮触发动作、BTT 付费路线、字符轮换动画（MTMR 全量重载会闪，
见「已知限制」）。

## 方案设计

### 架构：系统侧与渲染层解耦（v2 核心变更）

```
海獭后端 /api/conversations
        │ (curl, POLL_INTERVAL=5s)
        ▼
status-core.sh ── 聚合产出 Display Model JSON（稳定契约，版本化 v1）
        │            ~/Library/Application Support/OtterBar/display-model.json
        ▼
display-model.json
        │
        ├── renderer-mtmr.sh ── 当前载体：写 MTMR items.json
        └── renderer-swift（未来）── 自研 DFR 渲染端，消费同一份 model
```

Display Model v1 契约：

```json
{
  "v": 1,
  "sys_online": true,
  "waiting":  { "count": 17, "top": "📋 Backlog 排期" },
  "working":  { "convs": 3, "otters": 5 }
}
```

renderer 不访问后端 API，只读 model 文件——切换载体零改系统侧。model 契约变更
时升 v 字段，renderer 按 v 兼容。

### 四态判定（status-core.sh）

数据源：`GET /api/conversations` 单请求（web 前端本就 5 秒轮询同源数据）。

| 状态 | 判定 | 依据 |
|------|------|------|
| 🖤 系统离线 | curl 失败 / model 损坏或缺失 | 后端挂了是显式状态，不降级成睡觉（搭档明确要求：异常停止要一眼看出） |
| 🔴 等你介入 | active 会话 `unreadCount > 0` | 读没读本身就是时间窗——陈年 awaiting_user 会话（实测 44 个）只要没新未读就不刷屏 |
| ⌨️ 干活中 | `activityStatus == "processing"` 且 `lastMessageTs` 距今 ≤ 1800s | processing 可能因异常中断残留，新鲜度窗口兜底 |
| 💤 睡觉 | 在线且皆无 | — |

并存时合并显示：`🦦 🔴¹⁷ ⌨️3场5獭 · 📋 Backlog`（上标数字计数 + 未读最多的会话名
前 10 字）。干活显示会话数与去重海獭数（otterIds unique）。

关键取舍：**不用"行动权是否指向 user"判等你**——44 个 active 会话几乎全是历史遗留
awaiting_user（一周前），Touch Bar 会永久显示"等你×44"变成垃圾信息源。

### 渲染层（renderer-mtmr.sh）

- 徽章静态（无动画）：标题未变化时跳过写盘，避免 MTMR 无谓重载闪烁
- items 布局：左侧状态徽章（width 120）+ Esc + 音量/亮度系统控件（还原，搭档要求）
- MTMR 类型名以官方 defaultPreset.json 为准（escape/volumeDown/volumeUp/
  brightnessDown/brightnessUp）——踩坑两次：BTT 字段名（escapeTap/volume/
  align/bordered）会被解析成 unknown 徽章

### 部署：launchd 双 plist

core 与 renderer 分开常驻（RunAtLoad + KeepAlive）：换 renderer 载体时只动一个
plist。日志各自落 `/tmp/otterbar-{core,renderer}.*.log`。

## 安装步骤

1. `brew install --cask mtmr`（已完成）
2. 首次启动 MTMR.app 绕 Gatekeeper：右键打开或「隐私与安全性→仍要打开」（已完成；
   2020 年后未续签名，`xattr -d com.apple.quarantine` 清除隔离标记）
3. PR 合入 main 后：
   ```bash
   mkdir -p ~/Library/LaunchAgents
   cp scripts/launchd/com.otterbuddy.otterbar-*.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.otterbuddy.otterbar-core.plist
   launchctl load ~/Library/LaunchAgents/com.otterbuddy.otterbar-renderer-mtmr.plist
   ```

## 无 Touch Bar 机器安全性（搭档明确要求）

- **core**：只读 HTTP API 写 model 文件，与 Touch Bar 无关，任何机器可跑（菜单栏等
  未来载体复用同一 model）
- **renderer-mtmr**：只写 `~/Library/Application Support/MTMR/items.json` 文件，
  不碰硬件；未装 MTMR / 无 Touch Bar 的机器上该文件无人消费，纯孤儿文件，零副作用
- launchd KeepAlive 拉起的是两个 bash 脚本，崩溃重试无资源泄漏（每次循环 sleep 5s，
  单次 curl 超时 4s）

## 手动验证

- **四态渲染**（构造 model 实测）：
  - 离线：`🦦 🖤离线`；model 损坏（`not json{{{`）→ 离线态；model 文件缺失 → 离线态
  - 睡觉：`🦦 💤`
  - 等你+干活：`🦦 🔴¹⁷ ⌨️3场5獭 · 📋 Backlog`（上标计数，宽字符截断 10 字）
  - 真机 live：`🦦 ⌨️5场5獭`（core 5s 刷新 + renderer 增量写盘）
- **后端不可达降级**：curl -sf 失败 → 写 OFFLINE_MODEL，不崩溃不残留旧状态
- **lastMessageTs=null 边界**：fallback `"1970-01-01T00:00:00Z"`（初版 `"1970"`
  非 ISO8601 导致 jq 报错退出，`|| printf` 兜底把全部计数归零——检视发现 #713 R1）
- **动画闪烁实测**：MTMR 无局部刷新，字符轮换 = 整条 bar 每秒闪烁 → 移除动画改
  静态徽章（搭档确认「一直在闪」后收敛）
- **语法/结构**：`bash -n` 通过；双 plist `plutil -lint` 通过

## 影响范围

- 纯新增（4 个文件，均在 `scripts/`），不动主服务任何代码路径
- 后端唯一新增负载：每 5 秒一次 `/api/conversations`（与 web 前端轮询同源同频）
- 回滚 = 两个 `launchctl unload` + 删文件，零残留

## 已知限制与下一步

- **无动画**：MTMR 载体天花板（全量重载闪烁）。真动画（海獭表情/水波/跑马灯）需
  自研 Swift 渲染端走 DFR 私有接口——已提 issue 记录，搭档已确认方向
- **"等你介入"语义** = 有你没看过的消息（unreadCount），非"等你决策"——两者实践
  高度重合；在 web 读掉消息后状态回落"睡觉"属预期
- **processing 新鲜度窗口 1800s** 是估计值，异常中断会话在 30 分钟后才回落
- MTMR 0.27 是 Intel 原生最后一版，本机（x86_64）适用；M 系机器无 Touch Bar 不适用
