---
id: F20260921ehlt
title: e2e 健康检查窗口放宽至 150 秒
summary: e2e-server.sh 的 HEALTH_TIMEOUT 从 90s 放宽到 150s——同步启动链（schema → bge-m3 加载 ~30s → Document sync）全部完成才 listen，冷缓存 CI runner 上 90s 余量不足（#1077，PR #1071 flaky 实证）。
change_type: fix
capability_test: "n/a: CI 基建脚本参数调整，无 LLM 参与行为"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [ci, e2e, flaky]
modules: [scripts/e2e-server.sh]
---

# e2e 健康检查窗口放宽至 150 秒（#1077）

## 背景

PR #1071（otterbar Swift 单文件改动，CI ubuntu 不编译 Swift）e2e 偶发失败：`e2e server not healthy within 90s`。同 commit 重跑通过（2m19s）——flaky 实锤，与被测改动零关联。

## 根因（失败 run 日志实证）

e2e server 是同步启动链：Schema init → terminology seed → **bge-m3 embedding 加载（~30s，冷缓存 runner 波动大）** → Document sync → 才开始 listen。健康检查轮询 `/api/settings` 在 listen 前永远失败，90s 窗口对这条链在慢 runner 上余量不足：

- 失败 run（106189197172）日志：embedding 加载完成于启动后 ~31s，Document sync 进行中耗尽窗口
- 重跑（106190050793）：同 commit 2m19s 通过

## 改动

`HEALTH_TIMEOUT` 90 → 150（一行）+ 注释锚定实证与 #1077。进程死亡检测（`kill -0`）与端口预检不变——真挂了还是会快速失败，不是盲等。

## 方案取舍

issue 给了两方案，本 PR 落地方案 1（放宽窗口，止血）；**方案 2（分阶段健康：listen 提前 + 阶段端点报告「在推进 vs 真挂」）留档为后续演进**——它要求 main.ts 把 listen 提前到初始化前，半初始化状态下 /api/settings 等端点的行为需要逐个审计（404 vs 500 vs 旧数据），涉及启动顺序重构，不是止血该干的事。若 150s 后仍有复发再做。

## 已知边界

- 窗口放宽同时拉长「server 真挂时的最长空等」（150s）——但有进程死亡快速失败兜底（kill -0 检测），实际只有「活着但卡住」的形态会吃满窗口
- 验收口径（issue 里写的连续 10 次无复发）依赖后续多次 CI run 统计，本 PR 合入后观察

## Modification-Class

`narrow-fix`（既有超时参数校准，无新机制）
