---
id: F20261009psfx
title: "活类卡登记摘要先剥 script/style——修复游戏卡摘要成 JS 源码乱码（#1396）"
summary: "html-card-play 活类卡发言后自动登记的 fact 产物摘要提取正则只删 HTML 标签、不剥 <script> 块内容——游戏卡九成是 script，JS 源码漏进 180 字摘要（搭档试玩《獭之传说》灰盒时现场目击）。修复：摘要提取抽纯函数 extractPlayableCardSummary（先剥 script/style 整块含未闭合截断形态，按码点截断防 emoji 孤立代理）；契约同步补摘要提取规则与隐藏 div 摘要承载路径；speak 调用点守卫测试 2 例守护挂钩不回退（closes #1401）。"
change_type: fix
capability_test: "n/a: 纯函数摘要提取修复，验证走单测——tool-helpers.test.ts 31 用例（25 基础 + 登记摘要提取 4 例 + 检视处置 A1/A2 2 例）+ create-linked-resource-tool.test.ts 调用点守卫 2 例（speak 登记剥 script 源码 / 无围栏不登记）；全量 351 文件 / 5254 用例绿（CI run 37926723914，headSha f514f398，代码定稿轮配对）。"
created_in_conversation: cb80d695-bce9-4b83-9f2a-98618242acd0
created_at: 2026-10-09
tags: [conversation, bugfix, playable]
modules: [conversation]
related_issues: ["#1401"]
causal_links:
  from: [F20261009csp2]
intent:
  problem: "活类卡（html-card-play）登记摘要成 JS 源码乱码：autoRegisterPlayableCards 的摘要提取正则 card.value.replace(/<[^>]+>/g, \" \") 只删标签不删 <script> 块内容，游戏卡九成是 script，修复前实测摘要 (function(){ var S = { hp:100, mp:60, divined:false...（Playwright 同构沙盒复现）——搭档在时间轴上看到的产物卡是一坨源码。"
  expected_effect: "登记摘要 = 卡内可见文案（script/style 整块剔除后删标签）；纯 script 卡退化为（无可提取文本）；卡片作者可写隐藏 div（display:none）承载人话摘要。修复后实测摘要：终章灰盒试玩：先占卜获取情报...（v2 卡隐藏 div 生效）。"
  verify_by:
    type: capability_test
    reason: "tool-helpers.test.ts 31 用例（25 基础 + PR #1396 登记摘要提取 4 例 + 检视处置 A1/A2 2 例）+ 调用点守卫 2 例 + CI 351 文件 / 5254 用例绿 + 对抗审视五轮 delta 闭环。"
---

# 活类卡登记摘要先剥 script/style（#1396）

## 问题与现场

搭档在中间栏试玩《獭之传说》终章灰盒（html-card-play 活类卡），时间轴上自动登记的「事实」产物卡显示一坨乱码——`(function(){ var S = { hp:100...`。游戏本体渲染正常，乱的是登记摘要。

## 根因

`src/interface-adapters/agent-runtime/tools/tool-factory.ts:127`（修复前，`autoRegisterPlayableCards` 内联）：摘要提取正则 `card.value.replace(/<[^>]+>/g, " ")` 只删 HTML 标签、不删 `<script>` 块内容。活类游戏卡九成内容是 script 源码，去标签后 JS 源码整体漏进摘要，前 180 字成了源码片段。

## 修复

摘要提取抽纯函数 `extractPlayableCardSummary`（tool-helpers.ts 导出）：
1. 先剥 `<script>/<style>` 整块（`[\s\S]*?` 非贪婪，未闭合截断形态剥到结尾——检视 A1）
2. 再删标签取可见文本
3. 按码点截断避免 emoji 孤立代理对（检视 A2）

契约（html-card-contract-tool）同步补摘要提取规则：卡片作者可在 HTML 里写隐藏 div（`style="display:none"`）承载人话摘要；措辞经检视 N4 收窄——「除 script/style 外无可见文本才退化」，避免引导 LLM 多写隐藏 div。

## 检视处置留痕（PR #1396 五轮 delta）

- **A1/A2**（首轮建议）：未闭合 script 截断卡不漏源码 / emoji 截断不产生孤立代理——测试钉住
- **D2(a)**（第 2 轮严重）：speak 调用点集成测试 2 例（`create-linked-resource-tool.test.ts`）——含 html-card-play 围栏登记 fact 且摘要剥 script 源码 / 无围栏不登记，守护挂钩不回退（**closes #1401**）
- **N2**（第 2 轮建议）：A2 断言双反斜杠字面量误写（`[\\uD800-...]` 实为字面反斜杠类，断言空转）——改单反斜杠 unicode 范围恢复本意
- **D1 文档通道**（第 3 轮严重，本文件即处置）：原补丁节与计数修复原计划就地改 F20261009csp2，被 `lint-historical-docs` 拦（该文档已随 #1377 合入成历史文档，正文实质修改超 `.doc-fix` 仅限 frontmatter 范围，F20260922dfch 机制）——按门禁 header 规定的正当通道，新建本特性文档承接
- **N5/N7**（第 3/4 轮建议）：PR body / commit 验证数字订正为 CI 权威实测值 **350 文件 / 5251 用例**（run 37914085601，headSha e0738649，配对可复现）
- **D2 内容回退**（第 4 轮严重）：重写 commit 时两文件停在 pre-#1404 工作区版本，反向删除了已合入的 #1404 内容（18 行契约章节 + speak 六形态映射 description）——按处置 (a) 从 main 恢复两文件后重放本 PR 4 处编辑，验收判据三式全过（无越界删除行 / 六形态计数 1 与 1）
- **N10/N11**（第 5 轮建议）：run/headSha 锚点失实——5 处 run id 统一订正为代码定稿轮 run 37914085601（headSha e0738649，配对可复现），删除配对错误的 sha 引用 310a8354（该 sha 实有 run 37913975761，但与 run 37912017472 配对错误且已被挤出 ref——第 6 轮检视更正：非「无 run」）；轮次表述（三轮→五轮）与 PR body 删除行计数（3 处→5 条全量归属）订正
- **N12**（第 6 轮建议）：代码定稿轮 pin 前提被 #1405 rebase 证伪（`git diff e0738649 f514f398 -- ':!docs'` = 4 文件 +64/−10，系 rebase 带入的 #1405/#1403 交付）——四处证据行与 commit body 重 pin 至 **run 37926723914 ↔ headSha f514f398 ↔ 351 文件 / 5254 用例**，锚点策略行改写为可自验表述（见验证节）

## F20261009csp2 计数口径订正（承接 A3/N1）

原文档两处计数为交付时点快照，本 PR 落地后实测口径如下（历史文档就地修改被门禁拦，此处记录差异供追溯）：

- `capability_test`（line 6）：tool-helpers.test.ts 由 **25 用例 → 31 用例**（+登记摘要提取 4 例 + 检视处置 A1/A2 2 例）
- `verify_by.reason`（line 31）：「PlayableCard.test.tsx **6 用例**」应为 **8 用例**（PR #1377 合入时补齐，A3 首轮已指出）；tool-helpers 25 → 31
- 全量回归：347 文件 / 5209 用例（交付时点）→ 350 文件 / 5251 用例（#1404 后）→ **351 文件 / 5254 用例**（CI run 37926723914，headSha f514f398 权威值；#1405 合入 rebase 后）

## 影响范围

活类卡（html-card-play）发言后的产物登记摘要。普通 html-card 不参与登记，不受影响。Modification-Class: narrow-fix。

## 验证

- 修复前实测摘要：`(function(){ var S = { hp:100, mp:60, divined:false...`（Playwright 同构环境复现）
- 修复后实测摘要：`终章灰盒试玩：先占卜获取情报，召唤洞察獭补自测盲区...`（v2 卡隐藏 div 生效）
- CI run 37926723914（headSha f514f398，代码定稿轮）：check / golden-selftest / e2e 三 job 全 SUCCESS（351 文件 / 5254 用例）
- 锚点策略：commit 内 run 引用一律「run + headSha 配对」指向代码定稿轮 f514f398。**可自验**：本 commit 与 f514f398 的差异仅限本文档行级，`git diff f514f398..HEAD -- ':!docs'` 应为空；**每次 rebase 后需重新配对**（rebase 带入 main 新提交会证伪旧 pin，代码定稿轮随之前进）。最新 head 的 CI 结果以 PR checks 与 PR body 引用的 run 为准（行级文档修订无法前瞻自身推送后产生的 run id）
