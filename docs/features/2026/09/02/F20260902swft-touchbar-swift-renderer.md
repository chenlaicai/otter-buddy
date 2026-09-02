---
id: F20260902swft
title: Touch Bar 渲染端自研（Swift 常驻 view）：真动画替换 MTMR 载体
summary: 自研 Swift 渲染端 otterbar-renderer-swift，走常驻 NSTouchBar view + 12fps 帧动画路线（非 DFR 像素 surface），替换 MTMR 载体。五态行为兼容 #713，海獭呼吸/🔴脉冲/spinner 真动画，MTMR 双活让位，异常退出不劫持 bar。
change_type: feature
created: 2026-09-02
created_in_conversation: 31767a2b-4cb0-42d7-99c8-1afec8de6f08
issue: "721"
from:
  - F20260902tbar
tags:
  - touchbar
  - swift
  - renderer
  - animation
  - local-tooling
modules:
  - scripts/otterbar/swift/main.swift
  - scripts/otterbar/swift/build.sh
  - scripts/launchd/com.otterbuddy.otterbar-renderer-swift.plist
capability_test: "n/a: 本机 Touch Bar 工具（非主服务路径，CI 为 ubuntu 无法编译 AppKit），行为由 --selftest 断言矩阵 + 真机实测矩阵覆盖（见「验证」节）"
---

# Touch Bar 渲染端自研（Swift 常驻 view）：真动画替换 MTMR 载体

## 背景

#713（F20260902tbar）落地了 MTMR 载体的静态徽章。搭档验收反馈想要真动画（海獭表情、呼吸），但 MTMR 对 items.json 任何变化都整条 bar 全量重载（无局部刷新接口），字符轮换动画实测 = 整条闪烁，不可用。issue #721 立项自研渲染端，草案方向为 DFR 私有接口像素级绘制。

## 技术路线：为什么不是 DFR 像素 surface（关键决策）

Issue 草案方向是 DFR 私有接口（CreateCDPClient / DFRDevice 像素 surface）。研究阶段读了
MTMR 全部源码后，**结论是不需要、也不应该走 DFR surface 路线**：

1. **MTMR 闪烁根因不是载体**：`TouchBarController.reloadPreset` 对 items.json 任何变化都
   `createAndUpdatePreset` → 新建 NSTouchBar + 全部 item 重建（identifier 全新 UUID）→
   重新 present。闪烁是「销毁重建」造成的，不是 NSTouchBar 不能动画。
2. **生产实证**：MTMR 自家的时钟/CPU widget 在常驻 view 内 in-place 更新 label，从不闪烁
   ——常驻 NSView + 局部重绘路线在该载体上是通的。
3. **风险对比**：DFR surface 路线要逆向 SkyLight 私有调用链（SLSDFRDisplayStreamCreate 等），
   未知面大；常驻 view 路线唯一私有依赖是 Touch Bar 系统模态呈现函数（presentSystemModalTouchBar
   等 5 个符号，链接 DFRFoundation 私有框架），**与 MTMR 完全相同且本机已被 MTMR 生产实证**。

故最终路线：**公开 API（NSTouchBar + NSCustomTouchBarItem + 常驻 NSView）+ 12fps 帧动画 +
最小私有面（bar 呈现 5 符号）**。像素级自由绘制的需求（海獭表情动画）通过 CoreText 属性文本
绘制满足——本期能力见下。

## 方案设计

### 架构（继承 #713 契约，core 零改动）

```
status-core.sh（不变，每 5s 产出 display-model.json）
    ↓ 只读
otterbar-renderer-swift（本 PR，常驻进程）
    ├─ 2s 轮询 model → 状态归并（五态）
    ├─ 12fps 帧动画：海獭呼吸（字号正弦 ±0.9pt/4s 睡觉深慢）、🔴脉冲（透明度 1s 周期）、
    │   spinner 转轮（100ms/帧）——全部 in-place setNeedsDisplay，item 永不重建
    ├─ bar 布局：徽章(120pt) + esc + 音量×2 —— 常驻 NSTouchBar，present 一次
    └─ 系统键：Esc=CGEvent53；音量=CoreAudio 直设（见下）
```

### 五态行为兼容（与 renderer-mtmr.sh 逐态对齐，selftest 断言矩阵）

| 状态 | MTMR 版 | Swift 版 |
|---|---|---|
| 睡觉 | `🦦 💤` | 同 + 海獭深慢呼吸 |
| 等你 | `🦦 🔴ⁿ · top` | 同 + 🔴 脉冲 |
| 干活 | `🦦 ⌨️n场m獭` | 同 + spinner |
| 离线 | `🦦 🖤离线` | 同 + 弱呼吸降透明度 |
| 非主 | `⚠️非主·` 前缀 | 同前缀，叠加在线态 |
| 长离线 | 空配置退出 | 同：退出让位（KeepAlive 低频探测） |
| MTMR 在跑 | -（互斥未处理） | 检测到 MTMR 立即让位退出（用户手动启动 = 强意图） |

### 系统键的 macOS 26 实测结论（本期最大发现）

| 键 | 路线 | 结果 |
|---|---|---|
| Esc | CGEvent key53 | ✅ 可用 |
| 音量 | MTMR 同款 IOKit NX_SYSDEFINED（IOHIDPostEvent） | ❌ 返回 KERN_SUCCESS 但系统静默丢弃 |
| 音量 | NSEvent systemDefined 合成（MediaKeyTap 路线，3 种 tap 点） | ❌ 同样静默丢弃 |
| 音量 | 合成 F10/F11/F12 键码 | ❌ 媒体键语义在 HID 固件层，合成键码不带 |
| 音量 | **CoreAudio 直设默认输出设备 VolumeScalar（公开 API）** | ✅ **生效**（AppleScript 交叉验证 32→38→32→26，步进 6.25 对齐硬件） |
| 亮度 | CoreDisplay 私有（CGXGetDisplayBrightness / SetUserBrightness / SetLinearBrightness） | ❌ 段错误或 get fail（本机 macOS 26） |
| 亮度 | IOAVService 路线 | ❌ 符号已不在任何可链框架 |

定稿：Esc + 音量用真实功能键；**亮度键本期不设**（无公开 API，私有路线实测崩溃）——比 MTMR
载体更诚实：MTMR 的亮度键在 macOS 26 上同样是哑的（同一 IOKit 路线），只是视觉上存在。
（MTMR 运行时的验证：其音量键路线与实测失败路线完全相同。）

### 异常退出安全

- SIGTERM（launchd bootout）：`minimizeSystemModal` 优雅退位
- SIGKILL/crash：TouchBarServer 自动回收 surface（实测 kill -9 后 TouchBarServer 健在，bar 不被劫持）
- 常驻 item 只建一次永不重建（`touchBar(_:makeItemForIdentifier:)` 只被系统调一次）——不闪的根因保障

## 变更清单

- `scripts/otterbar/swift/main.swift` — 渲染端主体（含 selftest 11 项断言）
- `scripts/otterbar/swift/build.sh` — swiftc 编译脚本（本机编译，CI 为 ubuntu 无法编译 AppKit，与 #713 本机实测策略一致；二进制不入 git）
- `scripts/launchd/com.otterbuddy.otterbar-renderer-swift.plist` — launchd 常驻配置（KeepAlive + ThrottleInterval 60 复用 #713 双 plist 机制）

## v1→v2 演进（搭档验收驱动，检视獭-Swift2 发现 1）

- **v1（commit bc7af4f4）**：emoji 文本徽章（🦦🔴⌨️ 字符动画）+ esc 按钮 + CoreAudio 音量键
- **搭档验收 22:24**：系统键移除——bar 原生控制条已含 esc/音量/亮度，view 内集成是冗余；emoji 主视觉被评「简陋」
- **v2（commit 952eb94f）**：矢量海獭头像（扁宽脸/小贴耳/大扁鼻/白胡须）+ 状态环四态动效（琥珀呼吸/青弧旋转/夜蓝静止/灰虚线）+ 数据区（大数字/点阵）；v1 首版头像被搭档评「像只熊」，设计獭-水獭（glm-flash）出「去熊化」修正规格后落地 v2 终稿
- 系统键研究结论（macOS 26 媒体键静默丢弃/CoreAudio 可用）保留在下表存档，代码已移除，未来需要时按表捡回

## 验证（全部真机实测，本机 MacBookPro16,1 / macOS 26）

| 验收项（issue #721） | 方法 | 结果 |
|---|---|---|
| 行为兼容四态 | `--selftest` 状态归并断言 11 项矩阵（含 mixed 空 top / waiting nil / zero otters 边界态） | ✅ PASS |
| ≥10fps 动画不闪 | 12fps Timer 驱动 setNeedsDisplay；item 永不重建（结构保证）；搭档肉眼验收动画观感 | ✅ 结构性不闪；观感搭档已过 |
| 音量键功能 | `--test-key volumeUp/Down` + AppleScript 交叉验证 | ✅ 32→38→32→26 |
| Esc 键通道 | CGEvent 路线独立验证（同通道 cmd+space 可唤起 Spotlight） | ✅ 通道可用 |
| MTMR 双活让位 | 真机：渲染端运行中启动 MTMR → 渲染端日志 `exit: MTMR detected, yield` | ✅ |
| 长离线自禁 | model 写 offline_long=true → 进程退出，日志在案 | ✅ |
| SIGTERM 优雅退位 | kill -TERM → 进程退，bar 释放 | ✅ |
| crash 不劫持 bar | kill -9 → TouchBarServer 健在，bar 回归系统默认 | ✅ |
| 常驻稳定性 | 手动拉起后持续存活（>12s 观察窗 + 多轮测试累计数分钟） | ✅ |

已知限制：截图验证通道（screencapture -b）在本机返回全黑（MTMR 在跑时同样全黑），判定为
截图通道环境问题而非渲染问题——最终观感由搭档肉眼验收。

## 与 MTMR 的交接

- 部署 Swift 版时：`pkill MTMR` + 保留 renderer-mtmr launchd 任务（Swift 端会自动让位给手动启动的 MTMR，反之 Swift 端起来后 MTMR 若再启动，两者择一）
- `renderer-mtmr.sh` 保留在仓库（回退路径），生产切换由搭档决定时机

## 后续（不在本 PR）

- 海獭表情变化动画（表情帧序列，如干活时挠头、等你时张望）——CoreText 属性文本已有基础，加表情枚举即可
- 亮度键：等 macOS 提供公开 API 或找到可用私有路线再说
- OSD 弹窗：合成媒体键被 macOS 26 丢弃是系统行为，绕开需要 entitlement 的私有方案，不做
