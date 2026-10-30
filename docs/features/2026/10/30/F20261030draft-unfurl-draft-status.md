---
id: F20261030draft
title: "unfurl_cache 承载 draft 状态：DRAFT 徽章分支打通（#1463）"
summary: "F20261013csv3 遗留：gh fetch 已取 isDraft 但落库无承载——draft PR 落库 state='OPEN'，徽章误显「开放中」，UnfurlCard 的琥珀草稿分支不可达。补全全链：schema is_draft 列 + 存量库幂等迁移 + repo 存取 + UnfurlResult/api-contract/key-info 投影 + 双前端徽章 OPEN×isDraft 判定（draft 是 open 子态）；另修复检视 r1 处置中发现的同族断链（toKeyInfoDTO re-map 剥掉 unfurl 投影）。"
change_type: fix
capability_test: "n/a: 数据承载链补全（被修对象即投影链），以本节 Verification 证据链为验证载体"
intent:
  problem: "github-unfurl.ts:109 已取 gh isDraft，但 unfurl_cache 无 draft 承载字段——draft PR 落库 state='OPEN'，ArtifactCard/UnfurlCard 徽章显示「开放中」而非「草稿」，前端琥珀 DRAFT 徽章分支（UnfurlCard `d.state==='draft'`）不可达（落库从无 draft 值），四态徽章设计意图未兑现。"
  solution: "is_draft INTEGER 列（gh isDraft 布尔语义保留，不污染 state 的 OPEN/CLOSED/MERGED 枚举）+ 存量库 ALTER 幂等迁移（introduced_by_pr 同款模式）+ repo 存取三态（true/false/null）+ UnfurlResult/api-contract/key-info 投影链贯通 + 双前端徽章 OPEN×isDraft 判定（draft 是 open 子态；保留 state==='draft' 兼容分支）。另修复检视 r1 处置中发现的同族断链：toLinkedResourceDTO re-map 曾丢弃 unfurl 投影（GET key-resources 永不携带，ArtifactCard 徽章数据源断链）→ 补透传。"
  expected_effect: "draft PR 的徽章显示「草稿」（琥珀色），四态徽章（merged 紫/open 绿/closed 灰/draft 琥珀）设计意图兑现；draft → ready for review 后 upsert 覆盖，徽章实时转「开放中」；CLOSED×isDraft 交叉态正确显示「已关闭」（契约：state='OPEN' 且 isDraft 才显草稿）。"
  verify_by:
    type: behavior_check
    assertions:
      - "repo 存取三态 round-trip：isDraft true/false/null 均无损读出 + upsert 覆盖（draft→非 draft）"
      - "UnfurlCard/ArtifactCard 渲染：state='OPEN' 且 isDraft=true → 「草稿」出现、「开放中」不出现、琥珀类名命中；isDraft=false → 「开放中」不误显；CLOSED×isDraft=true → 「已关闭」"
      - "key-info 投影：GET key-resources 携带 unfurl，isDraft 三态全链无损透传（含 toKeyInfoDTO re-map 回归锁）"
      - "存量库补列迁移：老库 initSchema 后 is_draft 存在、老数据读 null、三态 round-trip、幂等重入"
      - "回归：后端 tests/api + tests/frameworks/db 65 文件 615 用例全过；web 全量 81 文件 820 用例全过；web tsc --noEmit 0 errors"
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
4. **前端徽章**：UnfurlCard/ArtifactCard 的 OPEN×isDraft 判定（draft 是 open 子态，
   限定 state='OPEN' 才显琥珀草稿——CLOSED×isDraft 交叉态正确显「已关闭」，检视 r1 建议 4）；
   保留 `state==='draft'` 兼容分支防旧数据。
5. **（r1 处置中发现）toKeyInfoDTO 断链修复**：key-info-dto.ts toLinkedResourceDTO
   曾逐字段重映射剥掉 unfurl 投影（GET key-resources 永远不带 unfurl，ArtifactCard 徽章
   数据源断链——F20261013csv3 T2 遗留同族断链，检视 r1 亦未抓到，处置中写 key-info
   投影测试时实证）→ 补 unfurl 透传（undefined 不带键/未抓取，null 保留/落空）。

Modification-Class 判定：**narrow-fix**（修法决策树①既有语义内修）——四态徽章是 F20261013csv3
既定设计（注释「draft=琥珀」早已在），本次是投影链丢字段的语义补全，零新机制。

## Verification（证据链）

> ⚠️ r1 审视修正（严重 2）：初版将「tsc 全绿」写入机器锚点但未真实执行 web 侧 tsc
> （根目录 tsc 不覆盖 web 子包），被 CI 证伪。以下为修复后（含 r1 全部处置）真实重跑结果。

1. **repo 存取测试**（unfurl-cache-repository.test.ts）：isDraft true/false/null 三态
   round-trip + upsert 覆盖（draft→非 draft）。
2. **前端渲染测试**（UnfurlCard.test.tsx + ArtifactCard.test.tsx）：OPEN×isDraft=true →
   「草稿」琥珀命中；isDraft=false → 「开放中」不误显；CLOSED×isDraft=true →「已关闭」
   且琥珀不出（建议 4 契约锁定）。
3. **key-info 投影测试**（key-info-unfurl-projection.test.ts）：GET key-resources 携带
   unfurl 投影 + isDraft 三态全链透传（同时是 toKeyInfoDTO re-map 断链的回归锁）。
4. **存量库补列迁移测试**（unfurl-draft-migration.test.ts）：老库补列 + 老数据读 null
   + 三态 round-trip + 幂等重入（migration-equivalence.guard 不覆盖的「存量表补列」路径）。
5. **回归**（本次执行）：后端 `npx vitest run tests/api tests/frameworks/db` → 65 文件
   `615 passed`；web `npx vitest run` → 81 文件 `820 passed`；web `npx tsc --noEmit` →
   `0 errors`（exit 0）。

## 影响范围

schema（+1 列 +1 迁移，迁移语句归位 createUnfurlCacheTable 尾部）、repo、unfurl-controller、
api-contract、key-info-controller、key-info-dto（unfurl 透传）、UnfurlCard/ArtifactCard
双前端组件及其类型（mappers.ts unfurl 形状改从 api-contract 派生）——全链各一处，无行为
破坏（旧数据 is_draft=NULL 读出为 null，徽章判定退化为原三态行为）。
