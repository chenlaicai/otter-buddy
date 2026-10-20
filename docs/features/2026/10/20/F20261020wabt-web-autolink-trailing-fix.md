---
title: Web 消息链接全角尾巴修剪——GFM autolink 修复补齐 Web 端
id: F20261020wabt
summary: GFM autolink 把裸 URL 后的全角标点/中文吸入 link.url（实证 http://127.0.0.1:5000）。 整段入链点不开），F20260920alnk 只修了 IM 投影层，Web 端（ReactMarkdown+remarkGfm）一直漏。补法：web 端 REMARK_PLUGINS 链新增 remark-autolink-trim 插件，mdast 层修剪 link.url 与文本（判定逻辑与 alnk 的 URL_TRAILING_CHAR 同源），行内链接与裸链 unfurl 全链路生效。
change_type: fix
created: 2026-10-20
created_in_conversation: 9ae84389-031a-4da1-be13-0238bcdf6a29
tags: [web, rendering, autolink, gfm, markdown, link]
modules:
  - web/src/lib/remark-autolink-trim.ts
  - web/src/lib/remark-autolink-trim.test.ts
  - web/src/pages/conversation/MessageList.tsx
from: [F20260920alnk, F20261008csf1]
---

# Web 消息链接全角尾巴修剪——GFM autolink 修复补齐 Web 端

## 1. 问题

搭档实证（2026-10-20）：Web 对话页消息「任务已完成，服务仍在运行（http://127.0.0.1:5000）。」——从 `http` 到最后的全角句号整段被识别为一个链接，点击打不开。

同类现象在消息流中普遍存在（裸 URL 后接全角标点或中文时），不是孤例。

## 2. 根因（已实证）

**GFM autolink 规范的边界设计**（与 F20260920alnk 同一根因）：对 `https?://` 起头的裸 URL，停止条件只有空白字符和 `<`。中文、全角标点不属于停止集，全部被吸入 URL。

最小复现（worktree web/node_modules，remark-parse + remark-gfm 4，与 MessageList 渲染管线同栈）：

```
输入: 任务已完成，服务仍在运行（http://127.0.0.1:5000）。
输出: link.url = "http://127.0.0.1:5000）。"
```

**为什么 IM 已好、Web 还坏**：F20260920alnk 的修复投放在 `projectForChannel`（服务端 IM 出站投影层，`src/entities/conversation/message-body-projection.ts`），alnk 特性文档当时就写明「Web 前端同样受影响，但本次修复投在投影层」——Web 端缺位是已知的遗留，本次补上。

**受影响链路**：消息 body → `MessageList.tsx` REMARK_PLUGINS（remarkGfm）→ `UnfurlAwareLink` → `<a href="...5000）。">`——href 带中文尾巴，浏览器打不开。

## 3. 方案

### 3.1 修法决策树：① 既有机制语义内补缺

alnk 机制（autolink 尾巴修剪）已存在并验证有效，本次是在其语义内补齐 Web 端的缺位投放点。机制识别检查点逐项核对：无新配置/状态/定时任务/信号/存储/决策分支/跨模块调用——纯渲染管线插件，命中清单零项，不涉净新增机制。commit 声明 `Modification-Class: narrow-fix`。

### 3.2 修在 mdast 节点层，与 alnk 的文本投影层各取各层

新增 `web/src/lib/remark-autolink-trim.ts` remark 插件，接入 `MessageList.tsx` 的 REMARK_PLUGINS（位置在 remarkBareLink 之前——裸链判定依赖修剪后的 url===text）：

- 遍历 mdast `link` 节点，`https?://` 起头且尾部非法（与 alnk 的 `URL_TRAILING_CHAR` 正则同源判定：RFC 3986 合法尾字符反向剥离）时修剪
- `link.url` 与链接文本同步修剪（autolink 的文本是 URL 字面量，文本带尾巴会展示误导）；剥下的碎片作为普通文本接回链接节点之后，阅读连续不丢字
- 尾部干净的链接直通零开销；GFM 已正确排除的半角尾巴（不平衡 `)`）不出现，平衡括号属 URL 本体不误剥
- 文本与尾巴错位时尽力而为停剥（不破坏原文）

**为何不在 Web 端也做文本投影**：Web 渲染管线是 ReactMarkdown 直出组件，无服务端投影环节；mdast 层改节点覆盖行内链接 + 裸链 unfurl（remarkBareLink 读 url===text 判定升级 UnfurlCard）全链路，且无 stringify round-trip 改写其他语法的风险。alnk 必须改出站文本（IM 渲染器在远端），本插件改解析树——同一判定逻辑，各取各层。

## 4. Verification

**失败证据链（troubleshooting 5a 固化）**：

- 修复前：失败测试因插件模块不存在而失败（`Failed to resolve import "./remark-autolink-trim"`）；最小复现脚本输出 `link.url = "http://127.0.0.1:5000）。"`（本档 §2）
- 修复后：`web/src/lib/remark-autolink-trim.test.ts` 7 项全过（搭档实证现场 / alnk 同款现场 / 干净直通 / query+fragment 保留 / 半角括号语义 / 显式链接不动 / 与 remarkBareLink 协作）；web 全量 731 测试绿；`tsc --noEmit` 干净

## 5. 影响范围

仅 Web 消息渲染（otter-body/user-body 变体的链接行）。IM 出站（已修剪文本）不受影响；event-log 变体不挂链接组件，无变化。
