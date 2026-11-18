---
id: F20261118banch
title: 注释编号禁绝——非特性文档注释一律不许出现编号
summary: |
  搭档拍板收紧：非特性文档（代码/配置/skill）的注释里不允许出现任何编号——特性编号
  （F/R 编号）、检视轮次编号（单字母序号 / 中文动作词+序号）、issue 编号（#N）。
  判据一句话：注释 why 用文字直接写清楚，编号是「跳去别处」的指针，没必要。
  三层落地：①写码獭读的 coding-principles 条款从「可带编号」改为「一律禁」；②检视獭
  读的 review-dimensions 增 B10 检查项；③CI 新增机械闸 check-pr-anchor-discipline（PR
  新增行注释硬拦截，退出码 1 阻塞合入）。存量分批整改由本特性链逐批清理。
change_type: feature
capability_test: "n/a: 判定器为纯函数单测（tests/scripts/check-pr-anchor-discipline.test.ts）；CI 闸为 workflow 声明式配置，无黄金轨迹可跑"
created_in_conversation: 3e928c99
causal_links:
  from:
    - F20261118rvcls   # 检视闭环机械闸（同场搭档点名的前一 P1，注释夹带编号的复发现场）
  supersedes:
    - F20261102fcmts   # 「非显而易见决策可带编号」的口子被本特性收紧为一律禁
tags: [code-hygiene, comment-anchor, ci, lint, mechanical-gate]
modules:
  - scripts/check-pr-anchor-discipline.mjs
  - .pi/skills/code-implementation/references/coding-principles.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
  - .github/workflows/ci.yml
created_at: 2026-11-18
intent:
  problem: "搭档两次点名「非特性文档注释夹带特性编号」复发（PR #1929 现场），#1482 旧条款允许「非显而易见决策带编号」的口子守不住——软条款靠人自觉失效"
  expected_effect: "PR 新增行注释出现特性/轮次/issue 编号时 CI 机械闸红并阻塞合入；写码獭条款与检视獭 B10 维度同步收口，复发归零"
  verify_by:
    type: static_only
    bugfix_acceptance:
      - "判定器：注释命中三类编号 → 违规列表非空；普通词（MP3/H264/机制名/流程描述）→ 空"
      - "注释识别：ts 系 // 与块注释、yml 井号注释均能提取；代码行与字符串字面量不误判"
      - "CI 闸：pull_request 事件跑 check-pr-anchor-discipline，新增注释编号时 check 红"
      - "自噬验证：闸对自己的新增文件（含测试拼接构造）exit 0，不误伤"
---

# 注释编号禁绝——非特性文档注释一律不许出现编号

## 背景

搭档 11/18 两次点名同一问题：非特性文档的代码注释夹带特性编号。第一次整改后复发（PR #1929 现场：ci.yml / 判定器脚本 / 后闸调用点 / 两测试文件共 10 处注释带特性编号，另有多处夹带检视轮次序号）。复发证明 #1482 旧条款「非显而易见决策可带编号」的口子是软条款，靠自觉守不住。

搭档最终拍板三条：

1. **非特性文档注释不允许出现任何编号**——特性编号、检视轮次编号、issue 编号一律禁，无例外；
2. **写 why 用文字直接写清楚**，不用编号外部溯源；
3. **存量必须整改**（存量代码会反向教坏 LLM），先建闸管新增、再分批清存量。

## 第一性原理

注释的职能是回答「为什么这么写」。编号（特性编号 / 轮次序号 / issue 号）的职能是「跳去别处取回决策史」——两者天生错配：读者看注释要的是当场读到 why，不是得到一张指示牌。凡是要靠跳转才能补齐的 why，说明 why 没有写进文字本身；把「为什么」写足，编号自然多余。

## 方案

### 三层落地（规则宣贯 + 机械闸）

| 对象 | 落点 | 内容 |
|---|---|---|
| 写码獭 | coding-principles.md「注释编号禁绝」 | 条款从「可带编号」改为「一律禁」，判据与口径收口 |
| 检视獭 | review-dimensions.md 新增 B10 | 每次检视必跑机械闸验证注释编号，命中 = 严重发现 |
| 机器 | scripts/check-pr-anchor-discipline.mjs + CI | PR 新增行注释硬拦截三类编号，退出码 1 阻塞合入 |

### 机械闸判定

- 检测对象：PR 新增行 only（防复发），存量分批整改不进闸（避免任何 PR 碰老文件即爆）
- 编号三类：特性编号（字母+8位日期+后缀形态，兼容历史识别形态）、检视轮次编号（单字母序号 / 中文动作词+序号，均含序号）、issue 编号（井号+数字）
- 注释识别：TS/JS 系（//、块注释、块注释 body 行导引符）、YAML/Shell/Python/Toml（井号注释）
- 排除：docs/features/（特性文档是编号的家）、dist 产物、锁文件与生成文件、纯 JSON、markdown（另行规范）
- 退出码：0 无违规 / 1 违规（回显 文件:行 + 编号类型）/ 2 拒判（空判定面不放行）

## 设计取舍

1. **新增行 only 而非变更文件全量**：全仓存量注释编号约 4500 处，绑定「变更文件全量」会让任何 PR 碰老文件先清几百处存量才能继续，阻塞开发。防复发靠「新增行拦截」，续命靠「存量分批清理」，两件事拆开各干各的。
2. **一律禁而非「补理由放行」**：搭档拍板推翻 #1482「非显而易见决策可带编号」的口子——不区分合法锚点与乱夹带，注释 why 一律用文字写清。这让闸从「声明闸」退化成更简单的「硬拦截」，无需 PR body 声明段，也无 34% 误伤率问题。
3. **轮次编号形态收紧为「含序号」**：delta 复核等无序号流程描述不算编号（是正常流程说明），只有带序号的（单字母序号 / 动作词+序号）才构成编号——避免规则描述自噬。
4. **闸对自己自噬的防御**：闸自身是新增代码，其规则描述注释与测试夹具必须不出现「注释导引符+编号」连续形态；测试数据运行时拼接构造。不设文件白名单特例。

## 变更清单

| 文件 | 变更 | 说明 |
|---|---|---|
| scripts/check-pr-anchor-discipline.mjs | 新增 | 判定器（纯函数 + diff 解析 + CLI） |
| scripts/check-pr-anchor-discipline.d.mts | 新增 | 类型声明 |
| tests/scripts/check-pr-anchor-discipline.test.ts | 新增 | 判定器单测（11 例） |
| .pi/skills/code-implementation/references/coding-principles.md | 修改 | 条款改为「注释编号禁绝」 |
| .pi/skills/adversarial-review/references/review-dimensions.md | 修改 | 新增 B10 检查项 |
| .github/workflows/ci.yml | 修改 | check job 加前闸 step |

## Rollback

Revert 本 PR 即回 main 现状：判定器脚本与测试为新增文件（删除即回）；ci.yml step 删除即回；两个 skill 文档条款复位即回。无 schema 变更、无历史数据迁移。

## 证据分层声明

- 机器锚点：判定器单测 11 例 + 冒烟（违规/干净/yml/自噬四态实测）；CI 前闸 pull_request 实跑
- agent 陈述：三类编号正则与注释识别口径由本特性文档与 #1482 A 类形态收口；自噬防御依赖测试夹具运行时拼接

## Golden Gate

Golden Gate: n/a（verify_by=static_only，判定器为纯函数单测，无 LLM 采样场景可跑）。

## 测试改动声明

方向：收紧。全部为新增测试（判定器 11 例），零存量测试删改。

## 存量整改承接

全仓非特性文档注释存量编号（特性编号约 4500 处 + 轮次序号 + issue 号）由本特性链后续分批清理：逐模块开清理 PR，每个清理 PR 本身经本闸验证（剥编号后的新增行为零违规）。本 PR 只建闸层，不混入存量清理（避免 4000+ 处改动的炸弹 PR）。