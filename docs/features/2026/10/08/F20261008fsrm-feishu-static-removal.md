---
id: F20261008fsrm
title: feishu 静态凭证残留全量移除（扫码为唯一接入方式）
summary: 搭档拍板终结迁移兼容期——config.yaml feishu 段不再读入（残留静默忽略）、启动 warn 退役、AppConfig.feishu 类型删除、静态搭档锚引用清理、文档迁移节改写为移除声明
change_type: refactor
capability_test: "tests/frameworks/config-service.test.ts"
intent:
  problem: "PR #1194 退役 feishu 静态凭证后留下三层兼容残留（config 读入兼容 + 启动 warn + 迁移文档节）。迁移引导 PR #1355 呈审时搭档拍板：保持系统只有一个扫码接入方式，不要残留历史的配置方式——兼容层本身就是残留"
  expected_effect: "config.yaml 残留 feishu 段被静默忽略（不读入、不告警、不进 AppConfig）；代码库无静态凭证解析路径；文档明示旧段已彻底移除"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-08
causal_links:
  - F20260929fsqr
tags: [im, feishu, config, cleanup]
modules: [im, config]
---

# F20261008fsrm feishu 静态凭证残留全量移除

## 背景

- 2026-09-29（F20260929fsqr / PR #1194）：feishu 静态凭证段退役，扫码双模式成为唯一接入路径。退役时保留三层兼容：config-service 读入兼容（`buildFeishuConfig` 返回 deprecated 标记）、app.ts 启动 warn 提示迁移、用户文档迁移指南节
- 2026-10-08：迁移引导 issue #1211 的实现 PR #1355（IM 页迁移引导条）呈终审时，搭档拍板否决引导方向——「保持当前系统就一个扫码接入方式，不要残留历史的配置方式」。方向从「引导迁移」转为「彻底移除」，#1355 已关闭

## 改动清单

| 位置 | 改动 |
|---|---|
| `src/frameworks/config-service.ts` | 删 `AppConfig.feishu` 类型块、`RawConfig.feishu` 类型块、`buildFeishuConfig()` 函数及其调用点；weixin 注释中 feishu.partnerOpenId 引用清理；留退役声明注释 |
| `src/app.ts` | 删启动 `if (config.feishu) warn` 迁移告警块；留退役声明注释 |
| `src/bootstrap/platforms.ts` | `createDispatchChainEngine` 缺省 PartnerResolver 构造 `appConfig.feishu?.partnerOpenId` → `undefined`（飞书搭档锚一律扫码首号，与 app.ts 全局 resolver 同口径） |
| `docs/user-guide/feishu-setup.md` | 「从旧静态凭证迁移」节（4 步迁移指引）改写为「旧静态凭证段（已彻底移除）」声明——保留「选择已有应用接回原 app」的一句话出口 |
| `tests/frameworks/config-service.test.ts` | +2 用例：残留 feishu 段静默忽略（cfg.feishu undefined）；干净配置行为不变 |

## 设计取舍

- **静默忽略而非报错**：残留段用户重启后无感知差异（原 warn 也只是日志一行）。报错会造成「升级即启动失败」，违背移除初衷。README/文档声明替代运行时提示
- **`FeishuConfig` 类型保留**：它是扫码线活代码（`buildScanFeishuConfig` 产出、feishu client 消费），死的只是「从 config.yaml 读静态段」这条路
- **PartnerResolver 飞书静态锚清理**：`appConfig.feishu?.partnerOpenId` 是静态段最后一个消费点，清理后与「搭档锚一律扫码首号」决策（F20260929fsqr）完全对齐
- **Modification-Class: deletion**——纯删除兼容层，无新机制

## 影响范围

- 无 feishu 段的部署（绝大多数）：零变化（本就无此路径）
- 残留 feishu 段的部署：启动 warn 消失，配置被静默忽略——接入状态与移除前一致（扫码线不受影响，静态段本就不启动）
- 风险低：删除的全是无消费者的兼容代码；tsc 全量 0 错佐证无悬空引用

## 已知边界

- 残缺 feishu 段（只留 encryptKey 等）与完整段同样被静默忽略——包括 #1355 R1 指出的「静默失联」场景，本拍板下该场景不存在「失联」（扫码线独立于 config，不受影响）

## 验证

- vitest 全量（见 PR CI）；config-service 域 41/41（含新增 2 用例）
- tsc --noEmit 0 错误（AppConfig.feishu 类型删除无悬空引用）
- 全仓 grep：`config.feishu` / `appConfig.feishu` / `buildFeishuConfig` 消费点清零（仅剩 feishu-scan.ts 两处历史注释引用，非代码）
