---
id: F20261022edgc
title: check-pr-tests 空 diff 假绿面 fail-closed：空判定面拒判不放行（M-0f8cf262）
summary: 测试弱化闸在 diff 为空（进程 cwd 非 PR 工作树/分支未更新）时误判「无删除行」放行，改为一律拒判（fail-closed），空判定面不再产生假绿。
change_type: fix
capability_test: "n/a: 纯 A 类闸脚本行为修复，无 LLM 参与行为"
intent:
  problem: "check-pr-tests.mjs 对空 diff 走「OK（无需声明）」exit 0——进程 cwd 不在 PR 工作树（主仓/无关仓/分支未更新）时 base...HEAD 无差异，闸空跑放行，测试弱化可从空判定面溜走（M-0f8cf262 假绿面）"
  expected_effect: "空 diff 一律拒判 exit 1 并给出 cwd/处置指引；非空 diff 各路径行为不变（删断言无声明 FAIL / 声明+理由 PASS / 非测试删除 OK）"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_at: 2026-10-22
from:
  - F20261013crit
tags: [tests, ci, fail-closed, check-pr-tests]
modules: [ci]
---

# check-pr-tests 空 diff 假绿面 fail-closed（M-0f8cf262）

## 背景与基线复现（探针 /tmp/probe-0f8cf262）

工单主张「进程 cwd 非 PR 工作树时 diff 为空应报错拒判」，实测基线：

| 探针 | 场景 | 修复前 | 判定 |
|---|---|---|---|
| P1 | PR 工作树删断言，`--base HEAD~1` | exit 1（拒） | 闸本体正常 ✓ |
| T2/P3 | 空 diff（`--base HEAD` / 无关仓） | `OK（无需声明）` **exit 0** | **假绿面，工单所述洞** |
| T1 | base 不可解析（`--base nosuchref`） | exit 1（git diff 失败） | 已 fail-closed，无需修 |

**排查插曲（如实记档）**：cwd=主仓的 node 探针出现「静默 exit 0、零输出」（P2/D1），一度疑似闸的第二 bug；对照实验（同一脚本在 /tmp 仓传 `--base nosuchref` 正常打印报错）证明命令根本未执行到脚本——是运行时守卫对主仓落点 node 执行的中和（自动重试静默替换），非闸缺陷。教训：探针基准必须在守卫不干预的落点（临时仓）取得，主仓落点探针结论不可信。

## 修法

修法决策树① 既有语义内修（`narrow-fix`）：闸的既有语义是「fail-closed 不放行」（有删除行但无 PR body 可核即拒），空 diff 是同一语义在「无判定对象」面的漏执行，不新增判定机制。

**机制识别检查点判定**：全未命中——新增分支是纯运行时临时拒判分支（结果不持久化、不写配置/存储，检查点明确豁免），无配置字段/生命周期/定时任务/信号/持久化/跨模块调用路径新增。

- `main()` 在 `parseNumstat` 后加空判定面分支：`files.length === 0` → 拒判信息（含 base、cwd 与处置指引）+ `exit 1`
- 退出码文档同步：0 通过 / 1 违规 / 1 拒判（diff 为空）
- 测试补四形态（tests/criteria/check-pr-tests.test.ts）：空 diff 拒判、干净仓拒判、base 不可解析 fail-closed 钉住、空 diff+有声明仍拒判（S1，锁拒判分支先于 body 判定）

## 取舍与剩余风险

- 净 diff 为空的极罕见 PR（如互相抵消的提交对）会被拒——fail-closed 保守侧取舍，错误信息指引人工处置；**不做空 diff 豁免口子**（口子即新假绿面）
- diff 非空但 cwd 在错误 worktree（闸判了别的树的 diff）不在本单射程：脚本无 PR 上下文无法辨识，如实声明为剩余风险
- 不军备化（#1513 之尺）：不加 PR 工作树指纹比对等穷举机制，只堵「空判定面放行」这一个洞

## Verification（bugfix 证据链）

修复前红证（`npx vitest run tests/criteria/check-pr-tests.test.ts`）：

```
FAIL 空 diff 拒判 > 红：base=HEAD 空 diff → 拒判 exit 1（不作「无删除行」放行）
AssertionError: expected +0 to be 1
FAIL 空 diff 拒判 > 红：干净仓（无任何变更）→ 同样拒判，不静默放行
AssertionError: expected +0 to be 1
Tests  2 failed | 17 passed (19)
```

修复后绿证：

```
Test Files  1 passed (1)
Tests  19 passed (19)
```

探针复验（同一 /tmp/probe-0f8cf262 基线）：

- P3 空 diff → `✗ diff 为空，拒判（fail-closed）` **exit 1**（原 exit 0 假绿，洞已封）
- P1 正判面无回归：删断言无声明仍 exit 1 + fail-closed 提示

Delta（S1，检视獭1616 建议采纳）：补「空 diff + 有测试改动声明 → 仍拒判」钉（20/20 绿），锁住拒判分支位于 body 判定之前——未来若分支被挪位，此钉即红。
