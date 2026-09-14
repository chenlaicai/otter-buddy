---
id: F20260910jnbd
title: controller JSON null body 防御缺口修复
summary: req.json() 解析合法 JSON null 成功不走 catch，body.xxx 解引用崩 500 并回显 V8 内部错误文本；本特性新增 safeJsonBody helper 统一兜底，修复 otter-controller（dissolve/restart）与 inbound-controller（receiveEvents）三处缺口。
change_type: fix
capability_test: "n/a: 纯后端 A 类代码变更，无 prompt/skill/协议层改动"
created_in_conversation: acf4e2d3-d0ae-4e93-90d8-a9d1f1f602b1
created_at: 2026-09-10
tags: [http, controller, bugfix, json, error-handling]
modules:
  - src/interface-adapters/http
---

# controller JSON null body 防御缺口修复

## 背景

PR #888 对抗审视（检视獭glm，PoC 实测）发现：防御写法 `await c.req.json().catch(() => ({}))` 存在残留变体——body 为合法 JSON `null` 时，`json()` 解析成功返回 null 不走 catch，后续 `body.xxx` 解引用崩溃返回 500，且回显 V8 内部错误文本（信息暴露）。#888 的 workspace-controller 当场修复，存量 controller 同型风险另立 issue #889 跟踪（搭档指令：「你来直接把 889 修复下，反正热乎的」）。

## 目标

T1: otter-controller dissolve（:86）与 restart（:112）的 JSON null body 崩溃修复
T2: inbound-controller receiveEvents 的 null body 崩溃修复
T3: 每处配「JSON null body」测试断言，防回归

## 非目标

- 不改各端点正常的 200/201 业务语义（null body 视为无 body，与非法 JSON 兜底语义一致）
- 不统一收敛全仓 `req.json()` 调用点（仅修 issue #889 登记的三处）

## 方案设计

| 位置 | 修复方式 |
|---|---|
| 新增 `src/interface-adapters/http/parse-json-body.ts` | `safeJsonBody<T>(c)` helper：`(await c.req.json().catch(() => ({}))) ?? {}`——非法 JSON 与 JSON null 统一兜底为 {} |
| otter-controller dissolve/restart | 改用 safeJsonBody，body.summary / body.modelAlias 缺省为 undefined（业务语义不变：summary 本就可选） |
| inbound-controller receiveEvents | 不用 helper——该端点有自定义 400 错误格式（`{ ok: false, error }`），在 json() 成功后显式判 `raw === null` 返 400 |

**为何 inbound 不用 helper**：inbound 端点面向外部桥接调用方，非法 JSON 本就返回带错误文本的 400（不是静默兜底 {}），null body 同理返 400 比兜底 {} 更诚实；且 `parseInboundRequest` 对 `{}` 会报「source 必填」400，两种修复殊途同归，选显式判空语义更清晰。

## 影响范围

- DELETE /api/otters/:id（dissolve）：null body 从 500 → 200（summary=undefined，与无 body 行为一致）
- POST /api/otters/:id/restart：null body 从 500 → 201（summary/modelAlias=undefined，与无 body 行为一致）
- POST /api/inbound/events：null body 从 500 → 400

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 兜底 {} vs 返 400 | otter 端点兜底 {}（语义不变），inbound 返 400（对外端点诚实报错） | 全部返 400 | otter 端点的非法 JSON 存量行为就是兜底 {} 走业务（summary 可选），改 400 属行为变更超出本 issue 范围 |
| 抽 helper vs 各处内联 | 抽 safeJsonBody（3 处中 2 处消费） | 各处内联 `?? {}` | 同型防御模式集中一处，下次新增端点可直接消费；inbound 因错误格式不同不消费，在 helper 注释中说明适用边界 |

## 验证

- 新增 4 个测试断言：otter.test.ts dissolve null body → 200、restart null body → 201；inbound-controller.test.ts null body → 400、非法 JSON → 400（防回退）
- 全量测试 248 files / 3124 tests：唯一失败 weixin-cold-start 经 `git stash -u` 基线复跑证实为 pre-existing（基线同失败，与 Home 目录已登录微信账号的环境依赖有关）
- tsc --noEmit 0 error、eslint 0 error

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/interface-adapters/http/parse-json-body.ts | 新增 | safeJsonBody helper |
| src/interface-adapters/http/controllers/otter-controller.ts | 修改 | dissolve/restart 改用 safeJsonBody |
| src/interface-adapters/http/controllers/inbound-controller.ts | 修改 | receiveEvents 显式判 null → 400 |
| tests/api/otter.test.ts | 修改 | +2 用例（dissolve/restart null body） |
| tests/interface-adapters/http/inbound-controller.test.ts | 新增 | null body 400 + 非法 JSON 400 回归 |
