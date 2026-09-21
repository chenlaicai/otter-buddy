---
id: F20260921gedg
title: git log 采集边界场景测试补齐
summary: 补齐 #426 列出的五类边界场景测试（rename/binary/空 commit/merge/多行 message）——基于各形态真实输出实测后写断言，其中 rename 双计假设被实测证伪（git log --name-only 只输出新路径），行为锁定防未来漂移。
change_type: test
capability_test: "n/a: 纯测试补充，无 LLM 参与行为"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [rhi, test, git-log, edge-case]
modules: [tests/usecases/health/git-log-collector.test.ts]
---

# git log 采集边界场景测试补齐（#426）

## 背景

PR #417 审视发现 5：RHI git log 采集缺五类边界场景测试——rename（担忧 `--name-only` 输出 old/new 两行导致热点双计）、binary、空 commit、merge 带 -m、多行 message。#399 bug_recurrence 依赖文件计数准确性，口径需锁定。

## 实测先行（写断言前先验证真实行为）

用临时仓库逐形态实测 `git log --format=... --name-only` 输出（2026-09-21，git 2.x）：

| 场景 | 实测输出 | issue 假设 |
|------|---------|-----------|
| rename commit（git mv） | **只输出新路径一行** | ⚠️ 假设双计——**不成立** |
| binary commit | 正常计入文件列表 | 一致 |
| 空 commit（--allow-empty） | 文件列表为空 | 一致 |
| merge commit（--no-ff 真合并，不带 -m 展开） | 文件列表为空 | 一致 |
| 多行 message | %s 只取首行，正文不渗入 | 一致 |

关键修正：**rename 双计在采集路径不存在**——`git log --name-only` 对 rename 只输出新路径（与 `diff-tree -r` 的 old+new 两行输出不同，后者只在 getCommitDetails 单 commit 详情路径使用）。issue 担忧的「热点把 rename 算两次」不成立，但该行为依赖 git 输出格式约定，测试锁定防未来漂移。

另实测踩坑：merge 测试必须 `--no-ff`——main 无分叉时默认 fast-forward 根本不产生 merge commit（首版测试就是因此红）。

## 新增用例（5）

- rename：filesChanged 只含新路径（行为锁定）
- binary：计入 filesChanged，与文本文件同权
- 空 commit：filesChanged=[]，解析不炸
- merge（--no-ff）：filesChanged=[]，与 metrics-calculator 侧「merge 空列表不计数」断言呼应
- 多行 message：message=纯标题行，filesChanged 不受污染

## 已知边界

- rename 断言锁定的是 `--name-only` 的当前行为——若 git 未来改为输出双路径，测试会红，届时需评估热点口径是否需要去重
- binary 场景用含 NUL 字节的真二进制（git 确实识别为 binary）

## Modification-Class

`narrow-fix`（纯测试补充，无产品代码改动）
