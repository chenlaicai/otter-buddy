---
id: F20261124bsfix
title: "引导文件配对码字段对齐：向导解析服务端 code 字段"
summary: "计划 C 验收发现的真实缺陷修复：bootstrap 端点下发字段为 code，首启向导只解析 pairingCode，导致真实下载的引导文件配对码被静默丢弃、自动带入从未在端到端成立。修复向导以 code 为主字段、pairingCode 为兼容别名，补服务端格式回归用例。"
change_type: bugfix
capability_test: "n/a: 纯确定性 JSON 解析行为，无 LLM 参与；由 A 类单测与计划 C 真实 PTY 复跑覆盖"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
created_at: 2026-11-24T16:55:00+08:00
tags: [connector, onboarding, bugfix]
modules: [connector]
causal_links:
  - "F20261124conex-executable-first-run：引导文件解析由该切片引入，本修复对齐其与 bootstrap 端点的字段契约"
intent:
  problem: "首启向导解析引导文件的配对码字段名（pairingCode）与服务端 bootstrap 端点下发字段名（code）不一致，真实下载的引导文件码被静默丢弃，自动带入只对手写文件成立"
  expected_effect: "真实浏览器下载的服务端格式引导文件（{hub, code, expiresAt}）在首启向导中完整预填 hub 与配对码；手写 pairingCode 文件仍可用；字段缺失/过期行为不变"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/connector/first-run-wizard.test.ts：服务端字段 code / 兼容别名 pairingCode / code 优先三级回归"
      - "计划 C 复跑：真实浏览器下载引导文件 → PTY 向导码预填断言（connector-onboarding-evidence/planc/）"
---

# 引导文件配对码字段对齐（#1981 计划 C 验收发现）

## 缺陷与根因

计划 C 验收（干净 HOME + 真实浏览器下载链）Phase 2 发现：向导从模拟新电脑的 Downloads 自动发现了引导文件、hub 预填正常，但**配对码未预填**（PTY 转录：`一次性配对码（Web 添加设备页生成）: ` 无 fallback）。根因：`GET/POST /api/connector/download/bootstrap` 下发 `{hub, code, expiresAt}`，而 `parseBootstrapJson` 只读 `obj.pairingCode`——两半各自被测试覆盖但从未在端到端相遇（PR-B 的 PTY 证据使用手写 pairingCode 文件，e2e 只断言端点 JSON 形态），字段契约在合入面破裂。

## 修复

`src/connector/first-run-wizard.ts`：`code` 为主字段（服务端格式），`pairingCode` 为兼容别名（手写文件容错），两字段同在时 code 优先。过期降级（丢码保 hub）、坏文件跳过、无时效不采码等语义不变。

## 失败用例证据（bugfix）

- 修复前：`parseBootstrapJson({hub, code, expiresAt})` 返回 `{hub}` 无码（新增回归用例 1 failed：`expected { hub: '…' } to deeply equal { hub, pairingCode }`）。
- 修复后：同套 7 tests passed。
- 真实链路证据：`connector-onboarding-evidence/planc/02-first-run-pty.log`（修复前 PTY 转录，码无 fallback）；修复后由计划 C 全链复跑覆盖。

## 机械验收

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 服务端格式 | parseBootstrapJson({hub, code, expiresAt 未过期}) | hub+pairingCode 均预填 |
| 兼容别名 | parseBootstrapJson({hub, pairingCode, expiresAt}) | 同上（手写文件不破） |
| 优先级 | code 与 pairingCode 同在 | code 生效 |
| 既有语义 | 过期/无 expiresAt/坏字段 | 丢码保 hub / 不采码 / 整体降级（不变） |

未覆盖边界：无新增（修复收敛于字段解析层）。
