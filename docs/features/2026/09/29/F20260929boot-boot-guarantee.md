---
id: F20260929boot
title: 启动保障：lint 挪出启动链 + 冒烟测试门（#1202 事故回溯）
summary: >-
  代码更新导致系统无法启动（PR #1202 事故）的机制性修复：
  lint 从启动链路（build）挪出，启动链只保留「没有它系统一定起不来」的编译检查；
  同时新增 smoke:boot 冒烟测试门（buildApp 全栈装配 + 真 sqlite + faux LLM），
  挂入 pre-commit 与 CI 的 check，让「系统能启动」从期望变成机械门槛。
change_type: feature
capability_test: n/a（纯工程链路变更，无 LLM 行为面；验证方式=冒烟测试门本身）
doc_type: feature
created_in_conversation: a443e1b3-01b3-4f84-a46a-94a95dbb5d43
tags: [boot, lint, ci, engineering-hygiene, smoke-test, incident-postmortem]
modules: [package.json, .githooks/pre-commit, scripts/smoke-boot.sh, tests/app/build-app.test.ts]
from: []
supersedes: []
created_at: 2026-09-29
---

# 启动保障：lint 挪出启动链 + 冒烟测试门

## 事故回溯（#1202，2026-09-29 上午）

**现象**：搭档 `git pull` 后重启系统，`npm start` 失败，海獭整体不可用，
只能借助外部第三方 agent（Claude Code）修复（PR #1202）。

**根因链**（全部有锚点）：

1. 前一日 17:17 `af38f9f2`（sleep 工具化 #1126）合入：sleep 检测从
   `bash-safety-guard.ts` 拆到 `sleep-command-guard.ts`，前者有效行数降到
   `max-lines 450` 上限以下 → 文件内 `eslint-disable max-lines` 指令变为 unused →
   lint 新增 warning。
2. 搭档早上 pull + 重启：`npm start` = `npm run build && node dist/src/main.js`，
   而 `build` 第一步就是 `npm run lint`（package.json）→ **lint 失败 →
   进程在 node 启动前就退出**。
3. 补刀：主仓根目录遗留未跟踪探针文件 `probe-924.test.mjs`，触发 `no-undef` error。
4. 日志侧证：`data/logs/otter-buddy.log`（139 万行）事故时段零进程崩溃记录
   （level 50/60 为空）——系统不是运行时挂的，是根本没活到运行时。

**预期 vs 实际对照**：排查前预注册判断「lint 被串进启动必经路径」——命中。

## 根因不是 lint 规则，是结构问题

三层叠加：

1. **lint 在启动链上是意外，不是决策**。`git log -S 'npm run lint' -- package.json`
   无任何特性文档做过这个取舍；刻意设计的门禁三层结构（F20260821kgts
   lint-gates-wiring：pre-commit → CI）恰恰**没有**包含启动链。
   该拦的地方（commit 前、merge 前）有门，不该拦的地方（系统启动）挂着锁。
2. **CI 与 lint 规则存在联合覆盖盲区**：每个 PR 单独 lint 都绿，但「PR-A 拆小文件」
   +「文件遗留 disable 指令」组合后，main 上首次出现 unused directive warning——
   组合态 lint 债 CI 天然防不住。
3. **探针文件裸奔**：临时文件在主仓根目录生成、未跟踪、无清理机制，被
   `eslint .` 全量扫到直接变 error。

## 机制设计

核心原则：**代码质量门（lint）负责代码健康，可用性门负责系统能起——两者不能共用一条链路**。

### 变更内容

| 变更 | 之前 | 之后 |
|------|------|------|
| `build` | `npm run lint && tsc …` | `tsc …`（只编译，不 lint） |
| `start` | `npm run build && node …`（经 build 隐式含 lint） | 同左，但 build 已不含 lint → **启动不再被 lint 拦** |
| `check` | `npm run build`（= lint + tsc） | `npm run build && npm run lint && npm run smoke:boot` |
| `smoke:boot`（新增） | — | `bash scripts/smoke-boot.sh` → `npx vitest run tests/app/build-app.test.ts` |

### 冒烟测试门的定位

- **不是新写的测试**：直接复用 `tests/app/build-app.test.ts`
  （fresh-db-migration-regression F20260805fmdb 时期沉淀的全栈装配测试）——
  真 sqlite 临时库、buildApp 全装配（真仓库/真用例/真控制器/真路由）、
  faux LLM（pi-ai 官方假 provider，不触网）、stub embedding（验证降级不炸启动）。
  测试已是单一真相源，复制即分叉。
- **门槛挂载点**：`check` 被 pre-commit hook（`.githooks/pre-commit:14`）与
  CI（`.github/workflows/ci.yml:107`）共用——commit 时和 merge 前都会跑，
  「这次代码能不能起」在最早环节暴露。
- **执行成本**：本地实测 6 个测试约 5 秒，可接受。

### 行为变化（对搭档）

- `npm start` / `npm run dev`：变快且更稳——只编译+起服务，lint 不再拦启动。
- commit 时：lint 依然跑（pre-commit → check），且**新增**冒烟测试（+约 5s）。
- CI：check job 同样新增冒烟测试。

## 设计取舍

**机制预算四问**（本特性命中「新增机制」检查点，动手前作答）：

1. **机制解决什么根因**：启动链路与代码质量门耦合，导致「代码丑」升级为「系统不可用」。
   根因是结构（lint 在启动链上），不是某条 lint 规则。
2. **最小实现是什么**：只动 package.json 三个 script + 新增一个 5 行 bash 脚本 +
   复用既有测试。不写新冒烟脚本（测试已是真相源）、不改 lint 规则本身、
   不动 CI yml（check 串联自动继承）。
3. **后续机制是什么**：若未来出现「编译过但启动挂」的新模式（如 DB migration 回归），
   冒烟测试应扩展覆盖（如真启动 listen 探针）；届时按修法决策树④评估。
4. **退役条件**：若 `buildApp` 被重构为启动即自证（如内置健康探针 + 启动超时熔断），
   本门可退役——但那是更重的机制，当前不值得。

**为什么不直接给 lint 加 warning 容忍**：warning 容忍是「降低标准」，
挪出启动链是「分离关切」——前者会让 lint 债继续累积且启动链依然脆弱，
后者让两件事各自成立。事故教训（#1202）要的是「系统必须能起」，
不是「lint 可以更松」。

**为什么不把 smoke 挂进 start 本身**：`npm start` 是搭档手动重启的入口，
每次启动都 +5s 不值得；冒烟门放在 commit/CI（代码变更的唯一入口）已能拦住
「pull 到不能起的代码」——代码不变化时冒烟结果不会变化。

## 验证

- [x] `npx vitest run tests/app/build-app.test.ts` 6/6 通过（约 5s）
- [x] `npm run build`（无 lint）通过，dist 正常产出
- [x] `npm run lint` 独立跑通过（EXIT=0）
- [x] 真实 dist 路径 buildApp 需真 LLM 配置（预期）——冒烟用 faux provider 覆盖装配层，
      LLM 端点可用性由既有健康检查覆盖
- [x] 最简实现检查：复用既有测试 + 3 个 script 改动 + 1 个 bash 脚本，无更简路径

## 影响范围

| 模块 | 影响 |
|------|------|
| package.json | build 去 lint；check 加 lint+smoke:boot；新增 smoke:boot script |
| scripts/smoke-boot.sh | 新增（5 行 bash 封装，调用既有 vitest） |
| .githooks/pre-commit | 无改动（check 串联自动继承冒烟门） |
| .github/workflows/ci.yml | 无改动（check job 自动继承冒烟门） |

## 关联

- 事故修复：PR #1202（外部 agent 修复 lint warning，本特性是机制性善后）
- 历史前科：F20260805fmdb（fresh-db-migration-regression——build 绿 ≠ 能起，
  build-app.test.ts 即该时期沉淀）
- 门禁设计：F20260821kgts（lint-gates-wiring——刻意设计的三层门禁，启动链是意外混入）
