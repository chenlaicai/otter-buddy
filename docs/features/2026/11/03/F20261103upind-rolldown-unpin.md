---
id: F20261103upind
title: rolldown pin 退役：上游 binding 完整后移除临时锁定（#1606）
change_type: fix
status: implemented
created: 2026-11-03
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - package.json
  - package-lock.json
summary: "#1606 退役：#1605（2026-10-22 依赖批次）临时锁定的 rolldown 精确 pin 移除。退役条件 1 已验证：rolldown@1.2.16 optionalDependencies 指向 binding-freebsd-x64@1.2.16 且该包 registry 实际可解析（1.2.15/1.2.16 均已补发——10-22 时缺的正是这批）。处置：npm uninstall rolldown 彻底移除 devDependencies 条目（git 实查确认 #1605 加 pin 前无此条目，rolldown 是 vitest→vite 的传递依赖，条目移除即恢复原态）+ lockfile 重生成（rolldown 1.2.16 传递解析，freebsd binding 3 条目入锁）。核验中纠正：pin 实为 1.2.15 非 issue 记载的 1.2.14（中途批次升级过但保持精确锁）。验证：npm ci 干净安装 + build + 426 文件 5633 测试 + lint 全绿（退役条件 2/3 满足）。"
tags: [deps, tech-debt, unpinned]
intent:
  problem: "devDependencies 唯一精确钉版是临时绕过上游缺陷的配置债——上游修复后 pin 不退役会滞后后续修复且有堆积成永久配置的风险"
  expected_effect: "rolldown 恢复传递依赖态随 vitest/vite 正常解析；devDependencies 回到零精确钉版惯例；后续 rolldown 修复自动跟进"
  verify_by:
    type: capability_test
capability_test: "退役条件 2/3 机器验证：npm ci 干净安装（Linux CI 同款校验路径，lockfile 完整性含 freebsd binding）+ npm run build + npm test 426 文件 5633 零回归 + lint——CI 上 Linux runner 的 npm ci 即当年炸掉的场景复验"
---

# rolldown pin 退役（#1606）

## 问题

PR #1605（2026-10-22）依赖批次发现 rolldown 1.2.15 声明的 `@rolldown/binding-freebsd-x64@1.2.15` 上游未发布——mac 本地 lockfile 裁掉该条目、Linux CI `npm ci` 校验锁完整性即炸。临时处置：devDependencies 精确锁定 rolldown（当时 1.2.14）绕过，立 #1606 跟踪退役。

## 退役验证与处置

**条件 1（2026-11-03 实查）**：`npm view rolldown@1.2.16 optionalDependencies` 指向 `binding-freebsd-x64@1.2.16`，该包 registry versions 含 1.2.15/1.2.16——上游已补发，完整可解析。比 regression-verify 11-21 兜底提前 18 天撞见。

**条件 2（移除）**：git 实查 `git log -S'"rolldown"' -- package.json` 确认 #1605 加 pin 前无此条目（rolldown 是 vitest→vite 传递依赖）——退役 = 彻底移除条目而非改范围锁。`npm uninstall rolldown` + lockfile 重生成：rolldown 1.2.16 传递解析，freebsd binding 3 条目入锁。

**条件 3（Linux 等价验证）**：`npm ci` 干净安装（当年炸掉的锁完整性路径）+ build + 426 文件 5633 测试 + lint 全绿。CI 的 Linux runner 会再跑一遍同路径（当年案发现场）。

**核验纠正**：pin 实为 `1.2.15` 非 issue 记载的 1.2.14——中途依赖批次升级过但保持精确锁形态（git blame 可溯）。

## 设计取舍

- **彻底移除条目 vs 改 `^1.2.16` 范围锁**：选前者——恢复 #1605 前的原态（零直接条目），rolldown 版本由 vitest/vite 解析链决定；显式条目（即使范围锁）会掩盖「这是谁的依赖」的问题
- **不锁 1.2.16 精确版**：上游缺陷已修，无需再防；后续rolldown 更新随正常依赖批次流动

## 验证

- [x] 条件 1：npm view 双包实查（optionalDependencies 指向 + registry versions 列表）
- [x] 条件 2：package.json rolldown 条目 0 命中；npm ls rolldown 确认 1.2.16 传递解析
- [x] 条件 3：npm ci 干净安装 + build 0 错 + 426 文件 5633 测试零回归 + lint 0 错
- [x] CI：Linux runner npm ci（当年案发现场路径）全绿——见 checks

## 影响

- devDependencies 回到零精确钉版惯例（临时配置债清偿）
- rolldown 后续修复自动跟进（不再滞后）
- freebsd binding 入锁——Linux CI 锁完整性校验有物可校
