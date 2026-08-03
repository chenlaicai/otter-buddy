---
id: F20260728skrp
title: skill-repo-safety
doc_type: feature

summary: |
  修复 skill 体系的入口错位：普适仓库红线（worktree 隔离、禁直提 main、PR-only）
  此前只装在入口很窄的 code-implementation（按方案做功能开发）里，导致「顺手提交
  小修复」类任务无人守门（事故：对话 t002，大獭未建 worktree 直接在主目录操作、
  试图在 main 上 commit、用 git branch -D 强删分支）。
  拆出独立 skill repo-safety，描述按任务性质（一切仓库改动，无论大小）而非用户
  话术编写；code-implementation 红线去重改为引用；core-workflow 排查小节加交叉
  引用，桥接「排查 → 提交修复」链路。

causal_links:
  from:
    - F20260728cbtf   # 同一起 t002 事故的第一次修复（熔断器字段）
    - F20260728cbwt   # 同一起事故的第二次修复（熔断器机制），流程问题由本文档收口

status: final
change_type: fix
tags: [skill, dev-process, repo-safety, worktree, incident-fix]
modules:
  - .pi/skills/repo-safety/SKILL.md
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/core-workflow/SKILL.md

created_at: 2026-07-28
---

# F20260728skrp 拆出 repo-safety skill，修复研发流程入口错位

## 术语定义

| 术语 | 定义 |
|------|------|
| **skill 入口** | SDK 注入 system prompt 的 `<available_skills>` 描述块；agent 凭 description 自行判断是否 read 对应 SKILL.md，是唯一的加载触发机制（纯软约束，无强制） |
| **入口错位** | 规则的适用范围与 skill 描述的触发范围不一致：规则是普适的，入口却只覆盖窄场景 |
| **repo-safety** | 新 skill，承载一切仓库改动的普适红线与最小流程 |

## 事故现象

2026-07-28 对话 **t002**，搭档任务：

> 这个修改我看见好几次了，我感觉是代码遗漏，每次重新编译都会出现这个 git diff。你确认下，如果是问题，那你就提交一个github pr

大獭的实际行为（session 转录）：

1. **未建 worktree**，直接在主目录 `/Users/orca/ai/otter-buddy` 执行全部 git 操作；
2. 分支状态混乱后**试图在 main 上直接 commit**，被 commit hook「错误：禁止直接提交到 main 分支」拦下；
3. 用 `git branch -D` 强删分支重建（破坏性操作）；
4. 全程**未 read 任何 skill**，也未按 BIG_OTTER.md 的分工设计用 `create_otter` 派开发小獭。

事后排查确认：skill 注入机制本身正常（SDK 在 system prompt 拼了 4 个 skill 的描述，大獭持有 read 工具），code-implementation 的内容也写得明确（"Never modify any files in the main directory"、"PR-only delivery"）——**它只是从未被加载**。

## 根因分析

### 根因：普适红线装在窄入口里，「小活儿」从缝里漏出去

code-implementation 的自我定位是「按技术方案做功能开发」（正文首句：Turn a technical plan into runnable, verifiable code changes；触发词全是「写代码」「按方案开发」「开干」）。但它体内藏着**普适规则**：一切文件改动都要 worktree、一切交付都走 PR。

大獭面对的任务是「确认一行 lockfile diff，是问题就提个 PR」——在身份 prompt「简单的事你直接上手做」的框架下，这被合理归类为杂活而非「开发」，code-implementation 的描述一次都没匹配上。即使匹配并阅读了，满篇 technical plan 的语境也会让模型判断「不适用于这个小活儿」。

### 触发词按用户话术写，进一步缩窄入口

原描述的触发词是用户原话枚举（"查一下"、"提交代码"）。真实任务是「你确认下……那就提交一个github pr」——字面不命中任何词条，需要模型自己做两层语义推理（确认=排查？提 PR=提交代码？）。 description 应描述**任务性质**，而非猜测用户措辞。

### 工程兜底有效但只兜住一半

commit hook 拦住了直提 main（兜底生效），但「主目录直接改文件」「branch -D」没有任何拦截。按「机制约束让 LLM 理解优先、工程拦截兜底」的原则，首先要修的是让 agent 在动手前知道规则——即把入口修对。

## 变更

### 新增 `.pi/skills/repo-safety/SKILL.md`

- **定位**：一切会改动 git 仓库的任务的唯一守门 skill，无论大小（lockfile、配置、文档提交都算）。
- **描述按任务性质写**："ANY task that mutates a git repository — committing, branching, pushing, opening a PR, editing tracked files — no matter how small"，并覆盖「排查结论需要提交修复」的桥接场景。
- **内容**：五条红线（主目录零改动 / 禁直提 main / PR-only / 禁破坏性 git 操作 / commit 模板一次写对不靠试错）+ 小改动最小流程 + 与 code-implementation、core-workflow 的关系。

### `.pi/skills/code-implementation/SKILL.md`

- Core Principles 中 worktree / PR-only / separation-of-duties 三条去重，改为引用 repo-safety（单一事实源，避免两处规则漂移）；
- Prepare Environment 一节同样改为引用；
- description 补充说明：任何仓库改动（含一行修复）都需同时加载 repo-safety。

### `.pi/skills/core-workflow/SKILL.md`

- 「排查问题」小节加交叉引用：排查结论若需要改动仓库 → 先加载 repo-safety 再动手。桥接「确认问题 → 提交修复」这条本次事故的实际链路。

## 设计决策（拍板史）

1. **不在身份 prompt 加硬规则**：曾提出在 BIG_OTTER.md / 消息前缀注入「改文件前必须读 skill」类硬约束，搭档拍板否决——过度矫正会把身份层变成规则堆砌，反而恶化。优化方向回到 skill 本身：入口修对，让模型在正确的时机自愿加载。
2. **拆独立 skill 而非改 code-implementation 描述**：普适红线与「按方案开发」是两种触发场景；单 skill 既要又要会让描述臃肿、匹配率下降。拆分后 repo-safety 短而锐，code-implementation 保持深度。
3. **交叉引用做桥，不做强制**：「排查 → 修复」的转场靠 core-workflow 里一句指引，与 skill 体系的软约束哲学一致；工程兜底（commit hook、分支保护）维持现状。
4. **大獭越过分工 DIY 的问题不动机制**：「硬活儿派小獭」是身份层分工设计，本次不修；入口修对后，大獭即使 DIY 也会被 repo-safety 拦住主目录直改。分工执行问题另行观察。

## 验证

- skill 内容由 SDK ResourceLoader 原样发现注入，无代码路径变更，`npm run check` 不受影响；
- 结构性验证：ResourceLoader 启动日志应显示发现 5 个 skill（原 4 个 + repo-safety）；
- 行为验收（重启系统后观察）：大獭/小獭面对「提交个 PR」类任务时，应先 read repo-safety，所有 git 写操作发生在 worktree 内。
