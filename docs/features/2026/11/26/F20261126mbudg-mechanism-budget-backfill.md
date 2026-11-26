---
id: F20261126mbudg
title: "11/19 三机制预算四问补录：issue 认领闸、PR 决策卡闸与 connector 强化"
summary: "回应 #1980 日报三条红灯：集中补录 F20261119claim、F20261119prcrd、F20261119cwssp 的决策归属、机械托底、证据下钻与退役条件。历史文档正文保持不变，本补录通过 causal_links 回链原特性。"
change_type: feature-update
capability_test: "n/a: 纯历史决策档案补录，不改运行行为；以 lint:intent、lint:docs 与独立文档审视为验证载体"
intent:
  problem: "2026-11-19 合入的 issue 认领双闸、PR 呈递决策卡双闸与 connector WSS/分发强化均属于持续机制，但原特性文档未集中回答机制预算四问，日报 #1980 因此留有三条红灯。"
  solution: "新建一份补录文档，逐项还原已合入机制的决策归属、机械校验、下钻入口与退役条件；不修改 main 上已有历史文档正文，不借补录改变既有设计。"
  expected_effect: "后续读者能从原特性跳转到同一份补录，核清三项机制谁拍板、靠什么机械约束、如何复查证据以及何时可以退役。"
  verify_by:
    type: static_only
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - {type: "extends", id: "F20261119claim", note: "补录 issue 认领双闸的机制预算四问"}
  - {type: "extends", id: "F20261119prcrd", note: "补录 PR 呈递决策卡双闸的机制预算四问"}
  - {type: "extends", id: "F20261119cwssp", note: "补录 connector WSS 双查与 packages 化的机制预算四问"}
  - {type: "fixes", id: "issue#1980", note: "处置 2026-11-19 日报补丁清单三条机制预算红灯"}
tags: [mechanism-budget, documentation, issue-claim, pr-card, connector]
modules: [docs]
---

# 11/19 三机制预算四问补录

## 背景与边界

#1980 的每日补丁清单指出：PR #1954、#1964、#1961 合入的持续机制没有集中交代机制预算四问。搭档于 2026-11-26 选择「1980补录三份机制四问后关闭」。

三份原特性文档已经进入 main 历史，按历史文档不可变铁律，本单不回改正文，而以本补录集中承接。以下只还原已合入设计与当时决策，不新增配置、状态、信号、存储或跨模块调用，也不重新批准任何线上行为。

## 一、issue 认领双闸（F20261119claim / PR #1954）

### 1. 决策者变了么

没有。issue 的工作认领仍由实际开工对话负责，冲突仲裁与 PR 合入仍按原协议由大獭/搭档处理。双闸只检查「认领是否存在、worktree F-ID 是否匹配」，不替任何对话选择任务，也不替搭档批准合入。

### 2. 靠自觉还是靠守卫

机械托底：

- commit-msg 侧闸在提交信息引用 issue 时核验 `otter-claim`，并以 worktree 私有 git-dir 内、绑定分支的 marker 缓存重复检查结果；本地网络失败 fail-open，由 CI 继续兜底。
- CI 前闸再次读取 issue 评论，检查有效认领、release 状态与分支 F-ID；查询失败按 CI 侧既定策略 fail-closed。
- `tests/scripts/check-pr-claim.test.ts` 与 `tests/scripts/commit-msg-claim-gate.test.ts` 固化正反路径、认领迁移、缓存隔离和 #1899 事故回归。

skill 文本仍承担并发认领、双 PR 与接管等需要语义判断的仲裁，不把它伪装成可机械判定的问题。

### 3. 深潜成本降了吗

降了。排查者可以沿「PR 分支 F-ID → issue 的 `otter-claim` 评论 → 认领对话/worktree → commit-msg 或 CI 闸输出 → 判定单测」逐层复核。发生重复开工时，GitHub 评论时间戳与 release 记录提供可定位的归属证据，不再只靠对话记忆。

### 4. 何时退役

仅在认领协议整体被新的跨对话归属机制取代、或项目明确取消 issue 认领要求时，经搭档拍板后同步退役 commit-msg/CI 双闸与对应测试。若只调整认领字段或 F-ID 规则，应修改既有判定并保留事故回归，不直接拆闸。退役前必须用新机制证明「未认领开工仍可被机械阻止」，或明确接受回到纯文本协议的双开工风险。

## 二、PR 呈递决策卡双闸（F20261119prcrd / PR #1964）

### 1. 决策者变了么

没有。是否合入仍由搭档拍板，检视獭仍只给技术结论。双闸只要求呈递时具备 PR 定位、验证证据、残留说明和授权按钮，不改变决策归属，也不把卡片存在等同于批准。

### 2. 靠自觉还是靠守卫

机械托底：

- speak 落库前辅闸拦截「PR 引用 + 纯请求措辞 + 无卡片」；yield to user 前主闸按回合累计发言检查决策卡与 `otterCard.submit` 提交信号，覆盖拆条规避。
- `tests/usecases/conversation/pr-card-gate.test.ts` 的 55 例矩阵与 `tests/interface-adapters/agent-runtime/tools/pr-card-gate-speak-yield.test.ts` 的 8 例集成测试锁定词表、否定、空壳边界、指代与补卡放行。
- `merge_pr` 仍独立校验搭档授权原话；卡片按钮只是合法授权源之一，不能绕过合入闸。

中文语气与 HTML/JS 空壳卡的语义判定属于明确记录的「半机械 + 异体审」边界，不能宣称按钮真实可执行已由机械证明。

### 3. 深潜成本降了吗

降了。搭档可从卡片下钻 CI、当前提交、检视回执、发现处置表与残留；出闸失败时可复查 speak/yield 拒绝原因，授权后可沿卡片回执、merge_pr 审计与 PR 时间线核对。相比散落在多段文字里的「可以合了」，决策依据与最终授权可以连成一条证据链。

### 4. 何时退役

仅在 PR 终审改由新的统一决策界面承载、且该界面同时覆盖证据下钻、残留呈报和可审计授权后，经搭档拍板退役双闸。若只是调整卡片样式或请求词表，不退役机制；应补回归样本。退役前必须证明新界面不会回到「文本请示、授权无源、残留不可见」的 #1952 形态，或明确接受该回退风险。

## 三、connector WSS 双查与独立分发（F20261119cwssp / PR #1961）

### 1. 决策者变了么

没有。公网部署、允许哪些 Origin、设备升级窗口与包发布仍由搭档/部署执行者决定。子协议 pin、Origin 白名单和包版本校验不会自行新增可信来源，也不会自动切换设备；它们只执行已确定的接入与分发约束。

### 2. 靠自觉还是靠守卫

机械托底：

- WSS 升级按子协议 pin（400）→ Origin exact match（403）→ Bearer token（401）顺序执行；未配置 Origin 表时拒绝所有带 Origin 的请求，无 Origin 的 node connector 保持既有行为。
- `tests/frameworks/execution/connector-ws-gateway.test.ts` 覆盖缺/错子协议、Origin fail-closed、exact match、子串仿冒与 token 组合面。
- connector 打包由 `check-connector-closure.mjs` 限制依赖闭包，`scripts/package-connector.mjs` 校验主仓与包版本一致并补 bin 可执行位；临时目录安装与 `npx otter-connector` 冒烟验证独立分发。

### 3. 深潜成本降了吗

降了。接入拒绝可沿状态码区分指纹、来源与秘密三层，部署者可对照 `OTTER_WS_ALLOWED_ORIGINS` 和实际请求头定位；分发问题可对照包版本、依赖闭包、tarball 内容与安装冒烟。旧客户端 400 的 breaking 也有明确升级路径，不再需要猜测是 token 失效还是协议漂移。

### 4. 何时退役

本特性包含两个可分别评估的持续机制，不能一刀切：

- WSS 双查仅在接入模型改变、且新机制提供等价的协议指纹与浏览器来源防护时退役；仅关闭公网暴露或撤销浏览器客户端需求时，也必须先确认无 Origin/跨站攻击面再放宽。
- packages 化仅在更换分发体系、且新载体继续提供版本一致、bin 可用与依赖闭包校验时退役。

两者都须由搭档/部署决策者拍板，并保留 gateway、闭包或安装冒烟的等价验证；不得以「当前没有浏览器客户端」为由同时撤掉子协议 pin 与 Bearer token。

## 验证与完成口径

- 本文只新增补录，不修改 `F20261119claim`、`F20261119prcrd`、`F20261119cwssp` 的历史正文。
- 文档检查：`npm run lint:intent` 与 `npm run lint:docs`。
- 独立文档审视重点：四问是否忠实于已合入实现、有无借补录新增设计、退役条件是否可判且未改变决策归属。
- PR 合入后，在 #1980 留评论回链本文与三个原特性，再按搭档 2026-11-26 的拍板关闭日报。
