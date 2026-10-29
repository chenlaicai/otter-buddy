---
id: F20261029dupfx
title: "测试播种去随机化：rhi-signal batch_bind 用例 filePath 生日碰撞 flake 修复（#1657）"
summary: "rhi-signal-tools-batch-bind.test.ts 的 seed() 用 4 字符随机段生成 filePath（36⁴≈1.68M 空间），「单批 100 截断」用例播种 130 行时生日碰撞概率 ~0.5%/次，碰撞两行被 upsert 按（signalType,filePath）去重合并 → totalMatched 129≠130 偶发红（CI run 40460881986 现场）。改单调计数器彻底消除随机性，含确定性失败复现与 100 连跑零失败验证。"
change_type: fix
capability_test: "n/a: 测试基建修复（被修对象即测试文件本身），以本节 Verification 证据链为验证载体"
intent:
  problem: "测试播种 filePath 用 Math.random 4 字符随机段，「单批 100 截断 + 续批收敛」用例循环播种 130 行时按生日问题期望 ~0.5%/次发生随机段碰撞，upsert 以（signalType, filePath）为去重键把碰撞两行并成一行，totalMatched 129≠130 偶发失败，表现为阻断 PR check CI 的神秘 flake（#1651 实撞），排障成本高。"
  solution: "seed() 改用模块级单调计数器 seedSeq++ 生成 filePath 后缀（src/<type>-<seq>.ts），播种序列确定且全局唯一，碰撞概率在构造上为零，不再依赖随机数质量。"
  expected_effect: "该测试文件不再产生生日碰撞 flake；CI 因此类随机段碰撞而偶发红的概率归零（构造性保证，非概率性降低）。"
  verify_by:
    type: behavior_check
    assertions:
      - "确定性复现（修复前）：临时 stub Math.random 为 129 周期固定序列（130 播种恰含 1 对重复），测试报 expected 129 to be 130——与野生失败签名逐字一致"
      - "修复后同一恶意 stub 下 7/7 全绿（修复与随机性彻底解耦）"
      - "最终态连跑 100 次全绿（0 失败）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [flaky-test, birthday-collision, rhi-signal, test-infra]
modules:
  - health
---

# 测试播种去随机化：filePath 生日碰撞 flake 修复（#1657）

## 背景

`tests/interface-adapters/agent-runtime/tools/rhi-signal-tools-batch-bind.test.ts` 的 `seed()` 辅助函数用
`Math.random().toString(36).slice(2, 6)` 生成 filePath 的随机段——4 个 base36 字符，空间 36⁴≈1.68M。
该写法随 #1237（F20260929tbbd）引入，自引入即如此。

「单批 100 截断 + 续批收敛」用例循环播种 130 行，而 `repo.upsert` 以 **(signalType, filePath)** 为去重键：
130 次抽取的生日碰撞期望概率 ≈ 130²/2 ÷ 36⁴ ≈ **0.5%/次**。碰撞发生时两行合并成一行，`totalMatched` 变成
129，断言 `toBe(130)` 失败。野生现场：CI run 40460881986（PR #1651，2026-10-27）`expected 129 to be 130`；
本地连跑 5 次复现 1 次，失败签名一致（均为播种 130 行、实际计数 129，恰好少 1）。

## 修法

`seed()` 改为模块级单调计数器：

```ts
let seedSeq = 0;
const seed = (signalType: string, severity: string) =>
  repo.upsert({
    signalType, severity, featureId: null, filePath: `src/${signalType}-${seedSeq++}.ts`, ...
  });
```

计数器在测试文件生命周期内单调递增，任意两次播种的 filePath 必不相同——碰撞概率在构造上为零，
而不是从 0.5% 降到 2e-8。issue #1657 修复方向二选一中即为「计数器方案更优」，本次照此实现。
修法决策树①（既有语义内修，narrow-fix）：被测行为（工具层 batch_bind 语义）零改动，仅测试播种数据生成方式变化。

## Verification（bugfix 证据链）

### 修复前失败输出（确定性复现）

复现装置：临时 stub `Math.random` 为 129 周期固定序列（`toString` 返回 `0.<4字符token>000`，token 按
周期内计数生成）——130 次播种恰好产生 1 对重复，模拟单次生日碰撞，不依赖概率：

```
FAIL  tests/.../rhi-signal-tools-batch-bind.test.ts > 单批 100 截断 + 续批收敛
AssertionError: expected 129 to be 130 // Object.is equality
- Expected: 130
+ Received: 129
```

与 CI run 40460881986 野生签名**逐字一致**；同文件其余 6 用例不受影响（播种数远小于周期）。

### 修复后通过输出

1. **同一恶意 stub 保持激活** + 修复 → `Test Files 1 passed (1) | Tests 7 passed (7)`
   （证明修复与随机性彻底解耦：filePath 不再经过 Math.random）
2. **最终态（stub 移除）连跑 100 次**：`DONE: 100 runs, 0 failures`
   （issue 验证断言原文：「修复后连跑 100 次零失败」）

### 运行环境备忘

本机沙箱 `kill EPERM`（见 #1698）导致 vitest forks 池收尾超时（每次多 ~10s wall），换 `--pool=threads`
规避；该现象与本修复无关，是沙箱进程终止限制的已知项。

## 影响范围

仅测试文件 1 处改动，不影响生产代码与被测行为。
