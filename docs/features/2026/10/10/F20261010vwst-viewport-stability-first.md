---
id: F20261010vwst
title: 滚动治理第 9 轮：视口稳定优先——删除 viewportObserver 贴底补偿
summary: "搭档 10-10 报告「输入框输入多行时中间栏消息跳动」。第一性原理分析：8 轮滚动修复共享同一结构性根因——8/13 弃 Virtuoso 时关闭浏览器原生滚动锚定后，「视觉稳定」责任 100% 落在自研代码，而自研代码用「枚举高度变化源」的方式履职，源是开放集合永远枚举不完。本轮删除 viewportObserver（视口高度变化→贴底拉回）补偿分支：视口高度变化时浏览器对 scrollTop 的 clamp 语义天然保证内容稳定，程序补偿反而制造跳动。落地「用户意图 × 高度变化类型」闭合行为矩阵作为规范。"
created: 2026-10-10
created_in_conversation: 27398619-8e0b-4147-8230-93e23f1a01ac
status: implemented
module: conversation
tags: [web, scroll, bugfix, design-principle]
causal_links:
  - F20260907sgpt（引入被删机制的双 RO 修正版——本案删除其 viewport 半边）
  - F20260813scrl（弃 Virtuoso + 关 overflow-anchor——结构性根因起点）
  - F20261009rwqa（三轮数据层修复——滚动治理第 8 轮，数据面）
  - issue #1408（alpha.sh 守卫误拦——本轮验证环境搭建踩到，已知不重复立案）
intent:
  problem: "贴底用户在输入框每敲一个换行，消息列表就被程序性顶起约一行高（~23px/行）——viewportObserver 把「输入框 autoResize 撑高压缩视口」误当成需要贴底拉回的信号"
  expected_effect: "贴底状态下输入多行/视口被任何来源压缩（指示条/窗口缩小）：scrollTop 帧级稳定（内容不动）；内容高度增长（新消息/流式/chip）仍正常贴底跟随"
  verify_by:
    type: behavior_check
---

# 滚动治理第 9 轮：视口稳定优先——删除 viewportObserver 贴底补偿

## 0. 一句话

视口高度变化时浏览器对 scrollTop 的 clamp 语义天然保证内容稳定，viewportObserver 的「视口缩小→贴底拉回」补偿分支是在给不需要补偿的场景打补丁——每敲一个换行就程序性顶起一行。删除它，让 contentObserver 独扛高度贴底；滚动行为从此由「用户意图 × 高度变化类型」闭合矩阵决定，不再枚举高度变化源。

## 1. 背景与问题现象

- 10/10 14:32 搭档报告：**输入框输入多行时，中间栏消息跳动**
- 10/10 14:42 搭档追加要求：「老在出这种小布丁，体感非常差。要从第一性原理出发去分析问题根源然后修复（**甚至是换设计都可以**）」
- 本轮是滚动治理第 9 轮（8/3 → 10/9 共 8 轮前史，见 §6 归位表）

## 2. 第一性原理分析

### 2.1 跳动的物理定义（三变量）

任何「跳动」最终都汇到滚动容器的三个物理量上：

- `scrollHeight`（内容总高）
- `clientHeight`（视口高）
- `scrollTop`（偏移）

**关键语义事实**：视口高度变化时（clientHeight 变），浏览器对 scrollTop 有天然 clamp——`scrollTop ≤ scrollHeight - clientHeight`。视口缩小 → 底部内容被裁掉一点，**内容本身纹丝不动**（scrollTop 不需要任何调整）。这是浏览器布局引擎给的免费稳定性保证。

### 2.2 八轮共有的结构性根因

8/13 弃用 react-virtuoso 那轮（F20260813scrl）同时关闭了浏览器原生滚动锚定（`overflow-anchor: none`，防 Virtuoso 三套滚动指令交叉打架的遗留）。从此「视觉稳定」的责任 100% 落在自研代码上，而自研代码的履职方式是**枚举高度变化源**：

- 信号 chip 异步到达 → 9/7 加 contentObserver（F20260907sgpt）
- 视口被指示条压缩 → 9/7 同轮加 viewportObserver
- 上翻加载恢复错位 → 10/8 修 W8 三重缺陷（F20261008w8lt）
- 用户意图误判 → 10/8 意图状态机（F20261008scpg）
- 60s 审计塞历史 → 10/9 快照窗口对齐（F20261009rwqa）
- 输入框 autoResize → **本轮**（第 6 个被枚举到的源）

每加一种 UI（chip、指示条、卡片、输入框自动撑高……）就多一个高度源，就得有人记得处理。**枚举源是开放集合，bug 是封闭集合，永远修不完**——这就是「老在出小布丁」的机制性解释。

### 2.3 闭合行为矩阵（本轮落地的规范）

滚动行为不由「哪个组件变了」决定（枚举不完），由「**用户意图 × 高度变化类型**」决定（闭合）：

| | 内容高度变化（scrollHeight） | 视口高度变化（clientHeight） |
|---|---|---|
| **pin 贴底** | 跟随到底（contentObserver，保留） | **稳定优先：不补偿**（浏览器 clamp 保证内容不动，底部被裁一点可接受） |
| **free 自由阅读** | 不打扰（意图状态机已保证） | 不打扰（同左） |
| **restore 加载恢复** | scrollTop += Δ（上翻历史 prepend，已有专门路径） | —（无此组合） |

对照矩阵审查现状：**viewportObserver 的补偿分支在矩阵里没有格子**——它服务的每个真实场景（输入框撑高/loadingMore 指示条/窗口缩小/GateBanner）的正确行为都是「不补偿」。它不是修错了什么，是它本身不该存在（troubleshooting skill 修法决策树③：删除机制，接受其当初解决的原始问题以更好的语义回归）。

## 3. 实现

### 3.1 变更（MessageList.tsx）

- 删除 `viewportObserver`（观测滚动容器、「视口减小且贴底→拉回」的 ResizeObserver）及其 `prevViewportHeightRef` 采样基线
- contentObserver（观测内容包裹 div）原样保留，独扛内容高度增长的贴底补偿
- 净变更约 -40 行（含注释更新），`Modification-Class: deletion`，机制识别清单全项未命中（纯删除，无新增配置/状态/定时/信号/存储/分支）

### 3.2 行为变化与取舍（诚实记录）

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| 贴底 + 输入多行 | 每换行被顶起 ~23px（本轮 bug） | scrollTop 帧级稳定 |
| 贴底 + loadingMore 指示条压缩视口 | 程序拉回底部 | 底部最后一条被裁一点，内容不动 |
| 贴底 + 窗口缩小 | 程序拉回底部 | 同上 |
| 贴底 + 内容增长（新消息/流式/chip） | 跟随到底 | 跟随到底（不变，contentObserver 保留） |

取舍理由：补偿错误的代价（跳动）直接破坏信任且用户无预期；「被裁一点」可一秒恢复（滚一下）且用户注意力通常不在内容底部（在窗口边缘/输入框）。逃生口：若实测体感差，加「幅度 >200px 才补偿」门槛（判据是幅度不是源——不回到枚举模式）。

### 3.3 换设计选项（记录在案，未采納）

**R3：重开 CSS scroll anchoring**（`overflow-anchor: auto`）。8/13 关它的原始理由（Virtuoso 指令打架）已随 Virtuoso 移除而消失。它能让 free 态获得浏览器级锚定（内容在锚点上方变化时视口稳定），但与贴底跟随（pin 态需要持续滚到底）的交互未经本项目验证，需专项 e2e 钉死。**若本轮后仍有残余滚动症状，R3 是下一张牌**（与 #1397 遗留的「180px 偶发」「闪顶回弹」症状处置同口径）。

## 4. 验证

- **单测**（MessageList.test.tsx）：
  - 结构断言重写：仅 1 个 observer 存在（contentObserver），无任何 observer 观测滚动容器（视口高度变化无程序响应路径的结构性保证）
  - 删除两个旧锚（「视口减小→贴底拉回」「视口增大→不写」——锚定的是被删机制本身）
  - contentObserver 既有 8 个行为用例全部保留通过
  - 全量 671/671 绿
- **e2e 场景 C**（scroll-pin-frame-guard.spec.ts，真实浏览器）：贴底下输入框逐行 Shift+Enter 输入 10 行，断言任何采样帧 scrollTop 偏离首帧 ≤4px（旧 bug ~23px/行累计 ~230px）；刺激源验收防恒绿（输入框末态高 >60px 证明 autoResize 真实生效）。依赖复刻环境（E2E_REPLICA_DATA 门控，CI 恒 skip——与既有 tri-msg-count 等同口径）
- **断言对象选择**：本场景断言 scrollTop 本身而非距底距离——视口高度变化时距底距离**合法地**变小（clientHeight 缩了），用距底断言会把合法变化误判为跳变

## 5. 影响范围

| 文件 | 变更 |
|------|------|
| `web/src/pages/conversation/MessageList.tsx` | 删 viewportObserver + prevViewportHeightRef，注释更新（矩阵原则） |
| `web/src/pages/conversation/MessageList.test.tsx` | 结构断言改单 observer，删 2 个旧锚，contentRO 查找方式改 DOM 直取 |
| `web/e2e/scroll-pin-frame-guard.spec.ts` | 新增场景 C（scrollTop 帧级稳定）+ TOP_SAMPLER |

## 6. 滚动治理九轮史归位（规范附录）

| 轮 | 时间 | 文档 | 根因层 | 与矩阵的关系 |
|---|---|---|---|---|
| 1 | 8/3 | F20260803vmsg | 消息展示重建 | 前史 |
| 2 | 8/13 | F20260813scrl | 弃 Virtuoso + 关原生锚定 | 结构性根因起点 |
| 3 | 8/14 | F20260814qswp | hooks 前置 | 无关（React 崩溃） |
| 4 | 9/7 | F20260907sgpt | 高度贴底补偿（双 RO） | contentObserver = 矩阵 pin×内容（保留）；viewportObserver = 无格子（本轮删） |
| 5 | 10/8 | F20261008scpg | 意图状态机 | = 矩阵的「用户意图」轴（保留） |
| 6 | 10/8 | F20261008w8lt | W8 恢复三重缺陷 | = 矩阵 restore×内容（保留） |
| 7 | 10/9 | F20261009csp2 等 | RO 冷启动 | contentObserver 可用性（保留） |
| 8 | 10/9 | F20261009rwqa | 快照窗口对齐 | 数据层（矩阵无关，保留） |
| 9 | 10/10 | **本文档** | 视口稳定优先 | 矩阵落地 + 删无格子机制 |

**新增 UI 的行为自查口径**：以后加任何会改变高度的 UI（折叠面板、图片懒加载、悬浮条……），不用读滚动代码——查矩阵：改变的是内容高还是视口高？用户 pin 还是 free？对号入座即得预期行为。若实测行为与矩阵不符，才是新 bug。

## 7. 遗留与边界

- 贴底 + 视口压缩「底部被裁一点不拉回」是新语义的已知代价（§3.2），逃生口已备
- #1397 遗留症状（偶发 ~180px 跳变、低频闪顶回弹）与本轮无关（量级/形态不同），再出现时按取证流程钉
- R3（重开 CSS 锚定）为下一张牌（§3.3）
- alpha.sh U5 误拦（issue #1408）本轮验证环境搭建再次踩到，手动复刻等效流程完成——不重复立案
