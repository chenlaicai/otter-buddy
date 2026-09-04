---
id: F20260904evdb
title: "数据核查防再发：sqlite3 直查先确认 dbPath + 关键数字双源验证 + 废弃文件清理 checklist"
summary: "issue #791 P1。同日搭档两次抓到数据错误（错查孤儿库 otter.db 得「零事件」、error_type 口径混排隐去 other:33），定调「错误数据比错误结论更恐怖」。本特性三处防再发：9:00 健康检查模板加 sqlite3 直查前置纪律（先 curl /api/settings 确认 dbPath）与关键数字双源验证纪律；code-implementation skill 步骤 6 加废弃资源清理 checklist（旧文件本体必须删除，不只改代码默认值）；测试锁住模板纪律行。"
change_type: prompt
capability_test: "tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts"
intent:
  problem: "海獭数据核查不查在用库路径、关键数字单源就写——错查孤儿库得出「零事件」假象（#791），口径混排把 other:33 拆散隐去；F20260829hviz 修复只改代码默认值不删旧文件，留下「看起来正常」的孤儿库"
  expected_effect: "9:00 日报产出中 sqlite3 直查场景先引用 dbPath 确认步骤；关键计数双源核对或标注「未交叉验证」；后续含路径迁移的 PR 按 skill checklist 删除旧文件本体"
  verify_by:
    type: capability_test
    effect_window: 1d
created: 2026-09-04
created_in_conversation: de5bcf98-7a4b-4e2e-9475-835359da0bd7
tags: [daily-review, prompt, evidence-integrity, issue-791, skill]
modules: [prompts/scheduled/daily-health-check.md, .pi/skills/code-implementation/SKILL.md, tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts]
---

## 背景

issue #791 P0 已闭环（孤儿库 otter.db 删除，其 22 条 health_snapshots 在主库同窗口全有且更全）。P1 防再发针对根因链的两环：

1. **路径无单一真相源的可发现性**：没有任何地方暴露「当前在用库路径」——`/api/settings` 接口现成返回 dbPath，但海獭核查数据时按文件名直觉抓库文件，错查了结构完整、schema 齐全、全表空的孤儿库，得出「自愈通道零使用」错误结论。错误数据差点胜过搭档的正确记忆（Self-Healing 任务每天在处理事件）。
2. **呈现失真**：另一次数据错误中，error_type 字段值（guard_intercept 等 7 类）与 description 内容分类（探针/服务重启等）两个口径混排一张表，把真实的 other:33 拆散重命名隐去——数字有出处但呈现失真，同样构成数据不实。
3. **废弃文件残留**：F20260829hviz Fix B 只改了代码默认路径，没删旧库文件本体——「看起来正常」的孤儿文件是 #791 事故的物质基础。

## 改动

### 1. prompts/scheduled/daily-health-check.md（真相源模板）

- 「必须检查的数据源」章节头部新增 **sqlite3 直查前置纪律**：任何 `sqlite3 <path>` 查询前，第一步先 `curl -s http://localhost:3000/api/settings` 确认 dbPath，核对即将查询的路径；附 #791 现场锚点（healing_events 查成 0 条 vs 实际 245 条）
- 数据源 7（signal_events）补注：跨对话 sqlite3 直查按前置纪律确认 dbPath
- 「分析纪律」新增 **关键数字双源验证**：关键计数（事件数/消息数/issue 数）用两个独立途径交叉核对（如 manage_healing_events query 结果 vs sqlite3 直查同表 COUNT），单源数字标注「未交叉验证」；附口径混排现场锚点
- 修正既有瑕疵：「先跑完上面 5 项数据源」实为 7 项（#797 增补数据源 6/7 后未同步该计数）

### 2. .pi/skills/code-implementation/SKILL.md（步骤 6 自检）

新增 **废弃资源清理 checklist**：变更若替换/迁移旧路径、旧文件、旧默认值，自检必查四件——①旧代码引用清零；②**旧文件本体删除**（不只改代码默认值，附 #791 现场）；③旧配置/环境变量迁移说明写入特性文档；④DB 运行时副本与 git 真相源同步。

### 3. tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts（新增）

3 用例锁定模板纪律行：sqlite3 前置纪律存在（curl /api/settings + 确认 dbPath）、双源验证纪律存在（含「未交叉验证」字样）、数据源清单 7 项编号完整。防后续模板编辑（如 #797 式增补）误删 #791 纪律行。

## 同步落库

模板真相源在 git，DB 是运行时副本——commit 后执行：

```
node scripts/update-scheduled-task-body.mjs --name "每日对话健康检查"
```

（脚本自动比对，body 不同才写库；CI 环境无 DB 自动跳过。）

## 验证

- [x] 模板纪律测试 3 用例通过（vitest run tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts）
- [x] 既有模板同步测试回归（tests/scripts/update-scheduled-task-body.test.ts、tests/usecases/scheduler/healing-analysis-template.test.ts）
- [x] intent lint（scripts/lint-intent.mjs）
- [x] golden gate（软代码改动：prompt + skill）——capability_test 型，测试即断言
- [x] 最简实现检查：零新建管线——前置纪律引用现成 /api/settings 接口（issue 建议方向），零接口开发；checklist 挂在既有 skill 步骤 6 下，不新建 skill；测试用例仅锁行不锁全文，编辑友好。已过最简检查。
- [ ] 明晨 9:00 日报首跑：产出中 sqlite3 直查场景是否引用 dbPath 确认（effect_window 内观察）

## 关联

- issue #791（本 PR 修复其 P1；P0 孤儿库删除已完成）
- F20260829hviz（根因链上游：Fix B 未删文件本体）
- F20260904dhs7（同为 daily-health-check.md 模板纪律增补，本特性新增第 4/5 条分析纪律）
- F20260904rclp（模板 git 化落库管线，本特性复用）
