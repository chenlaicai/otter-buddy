---
id: F20261030draft
title: "unfurl_cache 承载 draft 状态：DRAFT 徽章分支打通（#1463）"
summary: "F20261013csv3 遗留：gh fetch 已取 isDraft 但落库无承载——draft PR 落库 state='OPEN'，徽章误显「开放中」，UnfurlCard 的琥珀草稿分支不可达。补全全链：schema is_draft 列 + 存量库幂等迁移 + repo 存取 + UnfurlResult/api-contract/key-info 投影 + 双前端徽章 isDraft 判定（draft 是 open 子态，isDraft 前置判定）。"
change_type: fix
capability_test: "n/a: 数据承载链补全（被修对象即投影链），以本节 Verification 证据链为验证载体"
intent:
  problem: "github-unfurl.ts:109 已取 gh isDraft，但 unfurl_cache 无 draft 承载字段——draft PR 落库 state='OPEN'，ArtifactCard/UnfurlCard 徽章显示「开放中」而非「草稿」，前端琥珀 DRAFT 徽章分支（UnfurlCard `d.state==='draft'`）不可达（落库从无 draft 值），四态徽章设计意图未兑现。"
  solution: "is_draft INTEGER 列（gh isDraft 布尔语义保留，不污染 state 的 OPEN/CLOSED/MERGED 枚举）+ 存量库 ALTER 幂等迁移（introduced_by_pr 同款模式）+ repo 存取三态（true/false/null）+ UnfurlResult/api-contract/key-info 投影链贯通 + 双前端徽章 isDraft 前置判定（draft 是 open 子态；保留 state==='draft' 兼容分支）。"
  expected_effect: "draft PR 的徽章显示「草稿」（琥珀色），四态徽章（merged 紫/open 绿/closed 灰/draft 琥珀）设计意图兑现；draft → ready for review 后 upsert 覆盖，徽章实时转「开放中」。"
  verify_by:
    type: behavior_check
    assertions:
      - "repo 存取三态 round-trip：isDraft true/false/null 均无损读出 + upsert 覆盖（draft→非 draft）"
      - "UnfurlCard 渲染：state='OPEN' 且 isDraft=true → 「草稿」出现、「开放中」不出现、琥珀类名命中"
      - "回归：后端 tests/api + tests/frameworks/db/conversation 26 文件 342 用例全过；web 全量 81 文件 816 用例全过"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [unfurl, draft, badge, web, schema-migration]
modules:
  - web
---

# unfurl_cache 承载 draft 状态（#1463）

## 背景

F20261013csv3（PR #1461）的 delta 复核遗留：unfurl 投影链（fetch → 落库 → DTO → 前端徽章）在
落库环节丢失 draft 子态。gh CLI 侧 `isDraft` 已取（github-unfurl.ts:109），但 unfurl_cache 无承载列，
draft PR 的 state 落 'OPEN'，前端四态徽章的琥珀草稿分支不可达。

## 修法（issue 方案 3 步 + 迁移）

1. **schema**：`unfurl_cache` 加 `is_draft INTEGER`；`migrateDatabase` 加 `ALTER TABLE ... ADD COLUMN`
   幂等迁移（F20260824ax376 introduced_by_pr 同款模式，每列独立 try/catch——r1-A2 教训）。
   选 is_draft 独立列而非 state 落 'DRAFT'：gh 的 draft 是 open 的子态，state 枚举
   （OPEN/CLOSED/MERGED）不被污染，SQL 侧 `state='OPEN'` 查询不漏 draft。
2. **repo**：UnfurlCacheRow 加 `isDraft?: boolean | null`（三态），INSERT/UPSERT/SELECT 映射
   （boolean ↔ INTEGER 1/0，null 保留）。
3. **投影链**：UnfurlResult（unfurl-controller.ts）+ api-contract key-info unfurl 投影 +
   key-info-controller projectOne 全链携带；UnfurlData（前端）同步。
4. **前端徽章**：UnfurlCard/ArtifactCard 的 isDraft 前置判定（draft 是 open 子态，先于 OPEN 分支），
   琥珀 `bg-amber-400/20 text-amber-600`；保留 `state==='draft'` 兼容分支防旧数据。

Modification-Class 判定：**narrow-fix**（修法决策树①既有语义内修）——四态徽章是 F20261013csv3
既定设计（注释「draft=琥珀」早已在），本次是投影链丢字段的语义补全，零新机制。

## Verification（证据链）

1. **repo 存取测试**（unfurl-cache-repository.test.ts 新增用例）：isDraft true/false/null 三态
   round-trip + upsert 覆盖（draft→非 draft）——`35 passed`（该文件 + api/unfurl 合跑）。
2. **前端渲染测试**（UnfurlCard.test.tsx 新增用例）：state='OPEN' 且 isDraft=true →
   「草稿」出现、「开放中」不出现、琥珀类名命中——`12 passed`。
3. **回归**：后端 tests/api + tests/frameworks/db/conversation 26 文件 `342 passed`；
   web 全量 81 文件 `816 passed`。tsc 全绿。

## 影响范围

schema（+1 列 +1 迁移）、repo、unfurl-controller、api-contract、key-info-controller、
UnfurlCard/ArtifactCard 双前端组件及其类型——全链各一处，无行为破坏（旧数据 is_draft=NULL
读出为 null，徽章判定退化为原三态行为）。
