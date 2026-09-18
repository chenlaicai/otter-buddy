---
id: F20260917swsh
title: 三省吾身整合：定时任务收拢单对话 + 统一 issue 产生源 + 勾选式 issue 处理
summary: 搭档拍板把 5 个「每日三省吾身」类定时任务（健康检查/healing 分析/补丁清单/issue 处理/未闭环扫描）收拢到单一对话《三省吾身》，全部产出统一走 issue；每日 issue 处理从「自动干」改为「出清单等搭档勾选才开工」；删除每日复盘与 backlog digest 任务，归档三个旧对话。
doc_type: feature
change_type: feature
intent:
  problem: "5~6 个置顶系统对话各自每日产出消息，需要搭档介入的决策信息被后续自动消息顶走沉底；飞轮消费端（每日 issue 处理）disabled 形成真空，backlog digest 只读空转。"
  why_now: "搭档 2026-09-17 主动提出边界重复疑问并当场拍板终态（统一 issue 产生源 + 勾选式 issue 处理），是明确的布局重构窗口。"
  expected_effect: "置顶系统对话从 5~6 收敛到 1 个《三省吾身》；每日所有待决事项在 9:30 单一清单呈搭档勾选；无勾选不动工（已接受的取舍）。"
  verify_by:
    type: human_judge
    note: "布局重构效果由搭档日常体验判定；迁移脚本正确性经 --dry-run 预览 + 执行后 DB 状态核对"
capability_test: "tests/frameworks/config/features-config.test.ts"
created_in_conversation: 7fbc015a-9d23-4dac-ae6c-1ccf0289c3d6
created_at: 2026-09-17
tags: [scheduled-task, prompt, issue-loop, ux, conversation-layout]
modules: [prompts/scheduled/, src/usecases/daily-review/, src/usecases/healing/ensure-healing-scheduler.ts, src/bootstrap/feature-gates.ts, src/bootstrap/platforms.ts, src/frameworks/config-service.ts, src/frameworks/features-config.ts, scripts/migrate-sanxing-wushen.mjs]
---

# 三省吾身整合

## 背景与问题

搭档发现系统里「每日三省吾身」类定时任务膨胀到 5~6 个置顶对话（每日复盘 / Backlog 排期 / 架构整洁和过度设计 / Self-Healing×2 / 依赖升级），且交互上存在问题：需要人介入的决策信息会被后续自动消息顶走，搭档不及时看到就沉底。

讨论过程（对话 7fbc015a）中大獭先提出「两池 + 跨对话投递」方案，搭档判定搞复杂了，直接拍板：

1. 健康检查、healing 事件分析、整洁架构分析——产物都是 issue，全自动化，不需要介入
2. 依赖升级——固定内容出 PR，晚点看到没问题，不需要实时介入
3. 每日 issue 处理——是 1 的后续行动，排在 1 之后；**必须搭档同意才开工**（有些 issue 的问题可能不存在）
4. 炒股——个人场景，不在范围
5. 每日复盘的「未闭环事项」功能——新建 7:30 定时任务承接，**发现问题统一进 issue，后面统一处理**

## 终态设计（搭档拍板）

**对话：《🦦 三省吾身》**（原 🩺 Self-Healing 对话改名，id 3241317b 不变）

| 时间 | 任务 | 产出 |
|---|---|---|
| 7:30 | 未闭环扫描（新建） | 「回头再说」/未收尾事项 → issue |
| 8:00 | 整洁架构分析（补丁清单，DB 内 runtime 任务） | 补丁嫌疑 → issue |
| 8:30 | 每日对话健康检查（9:00→8:30） | 系统问题 → issue |
| 9:00 | self-healing-analysis（10:00→9:00） | healing 处置 → issue |
| 9:30 | 每日 issue 处理（复活+改造） | 全部待决 issue（含 D 类排期）→ 勾选清单，搭档勾选才开工 |
| 1:00 | 依赖升级自动化 | PR |
| 周一 10:00 | 上下文管理机制观察 | 异常才升级 |

删除：daily-review 每日复盘、backlog digest 两个任务。
归档对话：📖 每日复盘 / 📋 Backlog 排期 / 架构整洁和过度设计 / 上下文压缩交接相关的优化。

**模型统一**：四个产生源全部「发现问题 → issue」，9:30 一个口子呈搭档勾选消化。搭档的注意力入口从 5~6 个置顶对话收敛到 1 个。

## 改动清单

### prompts（git 真相源）

- **新建** `prompts/scheduled/未闭环扫描.md`：7:30 翻昨日对话捞「回头再说/待跟进/开了头没收尾」，逐条开 issue（body 必含来源锚点 + 原话引用——搭档 9:30 靠原话判断问题是否真实存在）；边界条款明确不碰系统状态（那是健康检查职责）
- **改造** `prompts/scheduled/每日-issue-处理.md`：
  - 开工纪律反转：删除「系统问题必修、搭档已授权不请示」的自动授权，改为**全部出勾选清单、搭档回复勾选后才开工**；不回则滚入次日清单（携带「已挂 N 天」标记）
  - 输入域加「D 类排期 issue 全量」（吸收原 backlog digest 的 tech-debt/enhancement 勾选职责）
  - 分类表加 unclear 的「问题本身可能不存在」判定（未闭环扫描产出常见）
- **删除** `prompts/scheduled/daily-review.md`（复盘任务废弃）

### 代码

- **删除** `src/usecases/daily-review/`（ensure 链 + constants 整个目录）
- `src/bootstrap/platforms.ts` / `src/app.ts`：摘除 dailyReviewInit 链
- `src/bootstrap/feature-gates.ts` / `src/frameworks/config-service.ts` / `src/frameworks/features-config.ts`：移除 features.dailyReview 开关（存量 config.yaml 里写了该键的，YAML 解析宽容忽略，不影响启动）
- `src/usecases/healing/ensure-healing-scheduler.ts`：HEALING_CRON 10:00→9:00（与 DB 迁移同步）
- `tests/frameworks/config/features-config.test.ts`：dailyReview 相关用例改写（124 测试全绿）

### DB 迁移（存量部署一次性）

`scripts/migrate-sanxing-wushen.mjs`（幂等，可重复运行；--dry-run 预览）：
对话改名 → cron 重排 + issue 处理复活 → 新建未闭环扫描任务 → 依赖升级/上下文观察挪入 → 删复盘/digest 任务 → 归档 4 个旧对话。

**执行时机：PR 合入后由搭档执行一次**（`node scripts/migrate-sanxing-wushen.mjs`）。服务重启后 prompt-template-reconciler 会自动把 每日-issue-处理 新 body 同步进 DB。

注意：补丁清单（每日 8:00）是 DB 内 runtime 任务、无 git 模板，本次不动其 body；但它原在架构整洁对话（a344e752）中，该对话将被归档——迁移脚本 step 4 已将其与依赖升级/上下文观察一併挪入三省吾身对话（检视发现 1，缺此步则归档后 scheduler 会自动 disable 它）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 未闭环事项的承接形态 | 独立 7:30 任务开 issue | 并进 9:30 清单直接列出 | 搭档拍板「发现问题统一进 issue，后面统一处理」——issue 是唯一队列，不维护第二队列 |
| issue 处理授权 | 全量勾选制 | actionable 保留自动授权 | 搭档：「有些 issue 问题可能都不存在」——全自动会修不存在的问题；代价是搭档不回复则当日不消化，已在 prompt 写明「已挂 N 天」滚动标记兜底 |
| 复盘任务 | 删除，功能由未闭环扫描承接 | 保留晨报形态 | 晨报形态正是「顶消息」问题来源；「昨天干了什么」段搭档自认在场不需要 |
| digest 任务 | 删除，D 类勾选并进 9:30 | 降频每周一 | 与 9:30 清单同一动作（列出待拍板 issue 等勾选），无独立存在理由（搭档确认） |
| dailyReview 开关 | 代码层移除 | 保留开关只关默认 | 机制预算：开关服务一个已删除的任务，留着是纯腐化 |
| 迁移方式 | 脚本随 PR、合入后搭档执行 | 代码启动迁移 | 存量布局调整是一次性动作，非常驻代码——启动迁移机制是新增机制，违背本特性自己推行的机制预算 |

## 检视处置记录（检视獭-swsh，2026-09-17 首轮意见全量处置）

| # | 发现 | 严重度 | 处置 |
|---|---|---|---|
| 1 | 迁移脚本遗漏补丁清单任务（归档后会被 scheduler 自动 disable） | 严重 | 已修：step 4 任务列表追加「每日补丁清单回看（F20260908pgrd）」；文档第 80 行失实陈述同步改正 |
| 2 | PR 标题缺 `[F20260917swsh]` ID 前缀，CI 失败 | 严重 | 已修：PR 标题改为 `[F20260917swsh][scheduler] ...` |
| 3 | 特性文档 frontmatter 无 intent 块（B6） | 严重 | 已修：补 intent（problem/why_now/expected_effect）+ verify_by: human_judge |
| 4 | results.jsonl 无本 PR Golden Gate 记录（B7） | 严重 | 豁免留痕：5 个 golden 场景全部锚定主对话行为（boot+sendUserMessage 真实采样，见 r4-summon/yield-handoff/talking-stone/mfrc/seriousness 各场景 originTest），输入域与定时任务 body 无交集，跑无判别力。走 PR 描述申诉留痕（v6.3 fail 处置三出口之「申诉留痕决议」） |
| 5 | B5 撞车：#1010 修改本 PR 删除的 daily-review.md | 严重 | 已修：#1010 的只读事实核实白名单条款吸收进 每日-issue-处理.md 数据源节（认领三问/自动关闭检查正是 gh 只读核实密集区）；#1010 待本 PR 合入后关闭，其特性文档 F20260917drvy 指向本 PR 吸收记录 |
| 6 | parseArgs() 双调用冗余 | 建议 | 已修：合并为单次调用 |
| 7 | 未闭环扫描引用不存在的 created_before 参数 | 建议 | 已修：改为 created_after + 人工过滤上界说明 |
| 8 | 测试 fixture 残留 daily-review 任务名 | 建议 | 已修：顺手改（一行 fixture，不值得开 issue 跟踪）→ 改为 self-healing-analysis |

## 验证

- `npx tsc --noEmit` 通过
- `npx vitest run tests/frameworks/config/features-config.test.ts tests/usecases/scheduler/` — 124 测试全绿
- 迁移脚本 `node --check` 通过；合入后搭档执行 `--dry-run` 预览再真实执行

## 关联

- 催生讨论：对话 7fbc015a（搭档：「好像咱们系统加了好多个每日任务来每日三省吾身，是否有些边界是重复的？」）
- F20260831whfw（issue/healing 闭环飞轮——本特性保留其骨架，消费端从自动改勾选）
- F20260915cfgt（seed 配置门 v2——dailyReview 开关随本特性移除）
- F20260908pgrd（补丁清单回看——任务保留，时间不动）
- F20260824dhck（健康检查数据源门禁——不动）

## 过程教训（非本 PR 范围，git 历史留档）

- **PR 与 main 冲突（DIRTY）时 GitHub 静默丢弃 pull_request 事件**——renamed/synchronize/reopened 全部不触发 CI 且无任何报错，`gh pr checks` 显示 no checks。教训：PR 长开后每次 push 都应确认 CI 真的排上了（`gh run list` 核对 SHA），别只看 push 成功；冲突要第一时间合 main 解决。
- 本 PR 实证链：00:23 push 582ad8a8 → 无 run → 空提交 be49a670 → 无 run → 检出 mergeStateStatus=DIRTY → 合 main 解决冲突 1367d7cc → CI 立即排队。
