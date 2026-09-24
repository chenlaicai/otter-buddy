---
id: F20260924mseu
title: Commit/PR 标题模块位词表契约：开放集 + 黑名单 + 单一真相源
summary: 模块位长期只定格式不定语义、四处信息源示例互不一致，导致 [agent] 占全历史 1/3 成垃圾桶、同义词碎裂（skill/skills、im/weixin/feishu 三分）——建立 src/entities/document/module-tags.ts 单一真相源：推荐词表引导（开放集不堵死）+ 自指词黑名单硬拒（agent 除名）+ 元测试锁三处镜像一致
change_type: prompt
capability_test: "n/a: hook/CI/文档层改动，验证走手工冒烟矩阵 + 元测试字符级比对"
intent:
  problem: "模块位语义从未定义——它该是功能域还是代码分层无答案，海獭按「改动文件大头在哪层」猜，而本仓主体是 agent 运行时，[agent] 占全历史合规 commit 约 1/3 成为「不知道填什么就填它」的垃圾桶；四处信息源（commit-convention/commit-msg hook/ci.yml/CONTRIBUTING）各给一套示例清单互不一致，convention 文档甚至示范 agent-runtime 连字符形态（会被 hook 正则硬拒）；同义词碎裂致健康面板「模块热区」聚合失真"
  expected_effect: "新 commit 模块位语义统一为「有边界的子系统名」；自指/兜底词（agent/runtime/core/system/general/misc/other）被 hook+CI 硬拒；推荐词表 15 词引导选择，清单外合法词开放（不堵死新功能域）；三处镜像由元测试锁死，单侧改动立即变红；健康面板热区归因从合入后逐步恢复可信（60 天滚动窗口自然消化历史口径）"
  verify_by:
    type: static_only
    reason: "hook/CI 为机械判定逻辑，无 LLM 行为可采样；验证走手工冒烟矩阵（8 组标题形态 × 通过/黑名单/提示/模板拒四分支）+ 元测试 10 例字符级比对"
created_in_conversation: b985855b-6b85-41db-b462-c0cca4a094a2
tags: [commit-convention, governance, single-source-of-truth, hook, ci]
modules: [".githooks/", ".github/workflows/", "src/entities/document/", "tests/entities/document/", "CONTRIBUTING.md", ".pi/skills/code-implementation/references/"]
created_at: 2026-09-24
---

## 背景

搭档观察（2026-09-24 对话「特性标题优化」）：「特性标题里模块部分大多都是 [agent]，但其实是 bash 拦截……我认为 [module] 应该是要填具体哪一模块的，系统没给出来，每次海獭就自由发挥。」

### 实测盘点（分析轮次工具返回锚点）

**生产端四处信息源互不同步**：

| 信息源 | 给的模块示例 |
|---|---|
| `commit-convention.md:11` | skills、**agent-runtime**、conversation |
| `.githooks/commit-msg:48` 报错文案 | agent、web、memory |
| `ci.yml:46` 报错文案 | agent、web、prompt、research |
| `CONTRIBUTING.md:24` | agent、web、readme、memory |

四处示例四套词，语义定义为零。且 convention 示范的 `agent-runtime`（连字符）会被 hook 正则 `[a-z]+` 硬拒——文档在教獭写会被拒绝的标题，全历史 0 条连字符模块实证。

**全历史模块词表碎裂**（main 全量统计）：`agent 83 / conversation 57 / web 56 / health 26 / prompt 22 / scheduler 21 / skills 20 / memory 10 / im 10 / weixin 8 / stock 7 / db 6 / toolchain 5 / healing 5 / deps 5 / ci 5 / skill 4 / scripts 4 / readme 4 / bootstrap 4 / rhi 3 / otterbar 3 / main 3 / feishu 3 / docs 3…`。同义词并存：skill/skills、im/weixin/feishu、health/rhi/healing、ci/toolchain/scripts/deps。

**消费端影响面**：`moduleStats` 喂健康面板「模块热区」展示（`cli-report.ts:47`）与 DB 快照（`snapshot-rows.ts:58`）；hotspot_imbalance 信号走 changeType 不走 module（`detect-signals.ts:338`），信号链未污染——影响限于热区归因展示失真 + 快照趋势积累垃圾数据。

### 搭档三条定调决策（对话原话）

1. 「不用 agent，因为 agent 范围是很大的，可以是 loop/session/invoke/yield 等等，但不能是 agent」→ **agent 除名**，拆 loop/session/guard/context 四词
2. 「给一些枚举是合理的，引导海獭使用正确的模块，但是同时也要给好说明，当已给的这些不满足时，海獭也可以自由给，不能把路堵死」→ **开放集**，枚举是引导不是白名单
3. 「ok」确认开放集 + 黑名单 + 数据收口三层方案

## 方案设计

### 语义定义（机制级不变量）

module = **有边界的子系统名**，回答「动了哪个子系统的行为」，不是代码分层、不是文件位置、不是项目本体。**禁止自指词**——词义覆盖整个项目本体的标签信息量趋零，放任会成为垃圾桶（agent 以 83 条历史实证此模式）。一个 commit 一个主子系统，跨子系统选行为变更最大的，双标签形态废除（热区聚合不双重计数）。

### 三层机制

1. **推荐词表（开放集）**：15 词 + 每词一行用法，写进 hook/CI 提示文案。清单内 → 静默通过；清单外合法词 → **不拦截**，打印提示「不在推荐清单，若高频请提出收编」。开放集防漂移靠数据收口（健康面板热区天然暴露清单外词频，高频词由每日体检或搭档收编），不靠闸——issue 侧 lint-issue-labels.mjs 已验证此路。
2. **黑名单硬拒**：agent/runtime/core/system/general/misc/other 七个自指/兜底词，commit-msg hook + ci.yml 硬拦。general 也在列——开放集下不需要兜底词：填不出模块的 commit 该停下来想一秒「我到底改了什么」（搭档方案讨论原话）。
3. **单一真相源**：`src/entities/document/module-tags.ts` 导出词表 + 用法 + 形态契约。hook/ci.yml 无法 import TS，人工内联镜像；`tests/entities/document/module-tags.test.ts` 元测试从两侧源码提取清单字符级比对（#667 fid-format 同款先例）。

### 写入侧严、读取侧宽（不对称设计）

- 写入侧（hook + ci.yml）：引导 + 拦黑名单
- 读取侧（commit-parser.ts）：**不动**，保持宽容正则——它要解析全部历史 commit，旧标签永远可解析，不回填；60 天滚动窗口自然消化新旧口径

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/entities/document/module-tags.ts` | A | 单一真相源：推荐词表 15 词 + 黑名单 7 词 + 用法 + 形态契约 |
| `tests/entities/document/module-tags.test.ts` | A | 元测试 10 例：三处镜像字符级一致 + 形态契约 + 文档指针校验 |
| `.githooks/commit-msg` | M | 模块位校验分支：推荐词静默/清单外提示/黑名单硬拒；报错文案更新 |
| `.github/workflows/ci.yml` | M | PR 标题检查报错文案：示例去 agent、指向真相源 |
| `CONTRIBUTING.md` | M | module 行改为指向真相源 |
| `.pi/skills/code-implementation/references/commit-convention.md` | M | module 行改为指向真相源，清除 agent-runtime 非法示例 |

## 机制识别四问（#775）

1. 是否净新增机制？**否**——收窄既有机制（模块位格式校验 → 语义校验），属 scope-reduction
2. 不可为点：无机械校验时，语义漂移已实证（全历史 1/3 [agent]）
3. 侵入性：写入侧仅拦 7 个黑名单词，清单外开放——自由度保留
4. 与信任哲学一致性：闸只挡错误（自指词/非法格式），不挡选择（填哪个词）——与 #775「信任扩展执行者的判断力」一致

## 验证

### 手工冒烟矩阵（commit-msg hook，8 组形态 × 四分支）

| 输入标题 | 预期 | 实测 |
|---|---|---|
| `[F...][guard][New Feature] ...` | 静默通过 | ✅ exit=0 |
| `[F...][agent][BugFix] ...` | 黑名单硬拒 | ✅ exit=1 + 推荐词表提示 |
| `[F...][stock][Feature Update] ...` | 清单外提示放行 | ✅ exit=0 + 收编提示 |
| `[F...][web][BugFix] ...` | 静默通过 | ✅ exit=0 |
| `[F...][general][Refactor] ...` | 黑名单硬拒 | ✅ exit=1 |
| `[F...][runtime][BugFix] ...` | 黑名单硬拒 | ✅ exit=1 |
| `[F...][web][im][BugFix] ...` | 双标签模板拒 | ✅ exit=1 |
| `[R...][memory] ...` | 静默通过 | ✅ exit=0 |

### 自动化

- 元测试 10 例全绿（`tests/entities/document/module-tags.test.ts`）
- 全量回归：280 测试文件 / 3866 测试全绿
- tsc --noEmit exit=0；新文件 eslint 零警告

### 已知非阻断项

- hook 内存量 bug：`grep -q '^\\[F'` 在 BSD grep 下报 "brackets not balanced"（stderr 噪音，不影响退出码与主逻辑），本特性不顺手修，留独立处理
- 历史 commit 不回填：健康面板热区新旧口径混排约 60 天（滚动窗口自然消化）

## 待办（后续收编信号）

- 清单外词频监控：每日体检或健康报告关注热区清单外词，≥3 次即收编进推荐词表（issue 侧 lint-issue-labels.mjs 同款机制）
- stock 通道若恢复活跃迭代，收编 stock 进推荐词表

## 取舍记录

| 选项 | 选择 | 理由 |
|---|---|---|
| 封闭枚举白名单 vs 开放集 | 开放集 | 封闭枚举要求每次新功能域先改三处镜像才能提交，拿机械闸管本该由判断管的事；搭档明言「不能把路堵死」 |
| general 兜底词 | 废除入黑名单 | 兜底词是下一个垃圾桶；开放集下填不出时该想清归属（搭档方案讨论定调） |
| agent 瘦身保留 vs 除名 | 除名 | 留着瘦身版照样被当安全牌乱用；搭档原话「不能是 agent」 |
| issue 侧标题模块统一 | 不动 | issue 侧是另一套开放集（服务分诊，lint-issue-labels.mjs 管），两套词表服务不同目的，统一制造耦合 |
| 历史 commit 回填 | 不回填 | 读侧宽容解析，60 天滚动窗口自然消化 |
