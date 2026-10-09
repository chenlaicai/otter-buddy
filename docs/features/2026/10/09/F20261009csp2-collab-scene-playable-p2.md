---
id: F20261009csp2
title: "协作现场形态补全 P2：活类可玩模式——html-card-play 围栏（默认展开运行 + 生命周期控制 + 产物登记挂钩）"
summary: "落实宪法 F20261008csfw P2：活类（游戏/demo/小工具）获得专属围栏 html-card-play——默认展开运行（折叠态没有玩法）、🎮 运行标识、暂停/重启控制（卸载即停/重挂归零）；与普通卡共享全部沙盒安全边界与卡数/体积预算；发言后自动登记为产物进时间轴混排。沙盒安全评估结论：现有边界（opaque origin + CSP 断网 + 逃逸检测）对可玩形态足够，不新增权限面。"
change_type: feature
capability_test: "n/a: 能力验证面 = web PlayableCard.test.tsx（6 用例：默认展开/徽章/暂停/重启/fenceIndex 共享/超预算降级）+ tests/interface-adapters/tool-helpers.test.ts（25 用例含活类预算共享 3 例）——普通 vitest 套件"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
causal_links:
  - "F20261008csfw"
  - "F20261008csf1"
  - "F20260728htar"
  - "F20260929ahgt"
modules:
  - web/src/pages/conversation/HtmlCard.tsx
  - web/src/pages/conversation/MessageList.tsx
  - web/src/lib/remark-html-card-index.ts
  - src/interface-adapters/agent-runtime/tools/tool-helpers.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - api-contract/api/html-card.ts
tags:
  - conversation-view
  - html-card
  - playable
  - product-form
created_at: "2026-10-09T09:30:00+08:00"
intent:
  problem: "宪法六形态中活类（感知动词「玩」）没有专属展示形态：游戏/demo 塞在普通 html-card 里默认折叠——用户要先点「展开渲染」才能玩，与「玩」的即时性矛盾；且活类卡不登记产物，时间轴上看不到它诞生过（P1 文类混排体系已有卡位但活类缺席）。"
  expected_effect: "① 活类卡（html-card-play 围栏）默认展开运行，头部「🎮 活类 · 运行中」徽章；② 暂停=卸载 iframe（脚本随之销毁）、重启=重挂载（状态归零）；③ 与普通卡共享卡数/体积预算（1+1=2 合法、3 张被拒）；④ 发言后自动登记 fact 类产物（🎮 前缀），进时间轴混排。"
  verify_by:
    type: capability_test
    reason: "PlayableCard.test.tsx 6 用例 + tool-helpers.test.ts 25 用例（含活类预算共享）+ 全量回归绿 + 对抗审视闭环。"
---

# 协作现场形态补全 P2：活类可玩模式

> 宪法见 F20261008csfw（协作现场世界观 v2）。P1（图/链/文）已合入 #1362；本文 P2 = 活类。

## 目标与非目标

**目标**：
1. `html-card-play` 围栏：活类专属语法，默认展开运行
2. 运行标识 + 生命周期控制：🎮 徽章、暂停（卸载即停）、重启（归零重跑）
3. 产物登记挂钩：活类发言自动登记 fact 产物，进 P1 时间轴混排
4. 沙盒安全评估（P2 前置承诺，见下节）

**非目标**：
- 不新增沙盒权限（不加 allow-same-origin/forms/popups，不放宽 CSP）
- 不做活类卡持久化存档/读档（localStorage 在 opaque origin 下天然隔离）
- 不做卡内多实例/联机（单卡单实例）
- P3 产物链视图（宪法：需要时再上，本轮不含）

## 沙盒安全评估（P2 前置承诺兑现）

**结论：现有边界对「可玩」足够，零权限面扩张。**

| 边界 | 现状（P1 前） | P2 变化 |
|---|---|---|
| origin | `sandbox="allow-scripts"`，绝不含 allow-same-origin → opaque origin，无同源 token 可偷 | 不变 |
| 网络 | CSP `default-src 'none'; connect-src 'none'` → fetch/XHR/WebSocket 全断 | 不变 |
| 表单外泄 | `form-action 'none'` | 不变 |
| 导航逃逸 | 二次 load 检测 → 降级 invalid | 不变 |
| 存储 | opaque origin 下 localStorage 抛异常/隔离 | 不变 |
| 预算 | 单消息 2 卡 / 单卡 64KB | play 围栏**计入同一预算**（正则 `(?!-reply)` 天然覆盖 `-play` 后缀） |

活类新增的唯一「行为预期」是脚本长驻（游戏循环 rAF/setTimeout）——这在技术上与普通交互卡无差异（普通卡本就 allow-scripts），活类只是让「持续运行」成为常态。**暂停=卸载 iframe** 的设计意味着没有 kill 通道需求：DOM 销毁时脚本上下文随之回收，游戏循环自然终止。

## 方案设计

### 围栏与渲染

- 语法：```html-card-play title="标题"（与 html-card 同构，title 必填）
- remark 层：`remark-html-card-index` 对 play 围栏共享 fenceIndex 计数器 + 写 `dataPlayable: true`（hProperties 通道，与 fenceIndex 同构）
- `MessageList.CardAwareCode`：匹配 `language-html-card-play` className，透传 `playable` prop
- `HtmlCard`：`playable` 时初始 view=expanded（宪法：折叠态没有玩法）、徽章 teal 底「🎮 活类 · 运行中」、按钮组 = 重启/暂停/看源码；`runNonce` 进 iframe key——重启强制重挂载
- 降级分支补 `data-card-id`（探针发现的既有缺口：超预算块此前无 id，测试无法定位）

### 服务端

- `countCardFences`/`measureCardFenceBytes`：正则 `(?:\`\`\`|~~~)html-card(?!-reply)` 同时计住两种围栏——play 是 html-card 的带后缀形态，天然入计；无代码分叉
- `autoRegisterPlayableCards`（tool-factory）：speak 落库后扫描 play 围栏，逐张登记 fact 类产物（title=`🎮 {围栏title}`，content=title+去标签文本前 180 字摘要，category=`playable-card`）。**best-effort**：登记失败仅 warn 不阻断发言（卡片本体已落库，损失的只是时间轴摘要卡）
- 契约工具（html-card-contract-tool）补「活类卡」章节：语法/预算共享/自动登记说明

### 产物登记的取舍

登记为 **fact 类型**（而非新增 playable 类型）：DTO 枚举不动（避免 contract 破坏性变更），`category="playable-card"` + `🎮` 前缀足以区分；P1 混排过滤器认 pr/file/fact 三类 resourceType——fact 直通车，活类产物卡立即进时间轴。

## 测试

| 文件 | 用例 | 覆盖 |
|---|---|---|
| web PlayableCard.test.tsx | 6 | 默认展开+徽章+控制钮、暂停卸载、重启重挂载（iframe key 变化）、fenceIndex 共享（1 普通+1 活类=0,1）、超预算降级、普通卡行为回归 |
| tests tool-helpers.test.ts | +3（共 25） | 1 普通+1 活类通过、+1 活类被拒（共享预算）、纯活类单卡通过 + hasCardFences |

排查记录：超预算降级块此前无 `data-card-id`（既有缺口，非本 PR 引入但被测试暴露）——已补，第三张卡可被定位断言。

## 取舍与已知限制

- **暂停=收起**：不另设 paused 视图态——卸载即停语义最简，恢复=再点开（脚本重跑）。游戏进度不保留（opaque origin 无存储可用，天然如此）
- **重启不保留状态**：runNonce 重挂载 = 冷启动。需要存档的游戏自己用 postMessage 桥把状态外寄（未来扩展点，P2 不做）
- **登记摘要去标签取 180 字**：Canvas 类游戏无可提取文本时摘要为「（无可提取文本）」——可接受的粗糙，标题仍是主检索键
- **多 play 围栏消息**：逐张登记（最多 2 张受预算保护）

## 后续

- P3 产物链视图（时间轴管现场、关系链管脉络——link_memory 图谱渲染）
- 右栏产物清单 tab 退役（P1 特性文档遗留项）
