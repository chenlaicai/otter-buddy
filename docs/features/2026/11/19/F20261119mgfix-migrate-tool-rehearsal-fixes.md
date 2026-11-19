---
id: F20261119mgfix
title: 迁移工具演练轮实证修复：tar AppleDouble 禁写 + 术语种子归位 dist + 白名单收敛
change_type: bugfix
tags: [migration, deploy, terminology, packaging]
modules: [scripts/migrate-lib.mjs, scripts/migrate-export.mjs, src/frameworks/db/memory/seed-terminology.ts, deploy/ecs/]
summary: 6c 演练轮（ECS 验证实例）三处实证修复：① export tar env 加 COPYFILE_DISABLE=1（macOS bsdtar 默认把 xattr 写成 ._* 条目混进 tar——实测 98632 个，manifest 对 staging 计算不含 → restore 多余文件检测 fail-closed 拒收；Linux 上无害）。② 术语种子从 data/terminology/（getRepoRoot 运行时读）归位 src 内编译期 import JSON——deploy 排除 data/ 且云端无 git 仓时 ENOENT 的路径基准问题结构性消失（检视 S1）。③ 白名单收敛：补 backgrounds/weixin（用户数据），拒 terminology/execution-machines（本地真相+裸拷 sqlite 风险，检视 S2）/quota-browser（cache）；部署单元 WorkingDirectory 收口数据根父。
intent:
  problem: "演练轮把 12.2G 真数据推过全链路（在线导出→传输→restore→verify→ECS 起服）暴露三处工具/部署缺陷：tar 元数据污染（多余文件检测挂）、术语种子路径基准断（云端起服 ENOENT）、白名单边界含糊（该迁的漏、不该迁的混）"
  expected_effect: "真切时工具一次过：tar 干净（与 manifest 严格同源）、术语种子随 dist 部署（不再依赖仓布局）、白名单语义清晰（用户数据迁/机器本地与 cache 不迁）+ runbook 演练实证注记（耗时/架构/纪律）"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/scripts/migrate-tools.test.ts：weixin 收录断言 + terminology/execution-machines/quota-browser 不迁断言（负向钉住）"
      - "ECS 演练现场复验：修复后布局起服成功（验证实例 22min 首扫后 /api/ping 通、数据抽查一致）"
capability_test: "tests/scripts/migrate-tools.test.ts"
---

# F20261119mgfix：迁移工具演练轮实证修复

## 三处修复

| # | 缺陷（演练实证） | 修复 |
|---|---|---|
| ① | mac bsdtar 把 xattr 写成 `._*` AppleDouble 混进 tar（98632 个）→ restore 多余检测拒收 | export tar env `COPYFILE_DISABLE=1` |
| ② | 术语种子 data/terminology/ 由 getRepoRoot 运行时读——deploy 排除 data/ + 云端无 git → 起服 ENOENT | 种子 git mv 进 src，编译期 import JSON（随 dist 部署，路径基准消失） |
| ③ | 白名单边界：漏 backgrounds/weixin；混入 execution-machines（本地真相+裸拷 sqlite 风险）/quota-browser（cache） | 收敛 MIGRATE_INCLUDES + 部署单元 WorkingDirectory=数据根父 + runbook 注记 |

## 检视处置（reviewer-1968-dspro 两严重）

- **S1（白名单收了 ≠ 服务会读）**：处置=术语种子归位 dist（结构性消除路径基准分歧）+ WorkingDirectory 收口数据根父（./data/* 全族统一，验证实例实证布局）
- **S2（execution-machines 裸拷 sqlite）**：处置=移出白名单（对齐特性文档「执行机本地真相不迁移不备份」）；quota-browser 同理

## 演练实证注记（入 runbook）

在线导出 17min/传输 ~1h（上行硬顶→真切=预热全量+停服窗口增量）/restore 6min/verify 4min/起服首扫 22min；双实例=定时任务双跑（真切序列停本机后才起云端）；磁盘纪律（restore 后删 tar）。
