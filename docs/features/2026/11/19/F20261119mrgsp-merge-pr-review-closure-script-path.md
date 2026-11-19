---
id: F20261119mrgsp
title: "merge_pr 检视闭环闸脚本路径锚定修复：固定层数上溯在 dist/src 产物布局下指向不存在路径（#1949）"
summary: "检视闭环闸（#1929 引入的合入点 fail-closed 物理闸）用 import.meta.url 固定上溯 4 层定位 scripts/check-pr-review-closure.mjs——注释假设产物在 dist/interface-adapters（4 层深），实际 tsc 产物在 dist/src/interface-adapters（5 层），拼出不存在的 dist/scripts/ 路径。首次真实合入（PR #1947）即崩，模块缺失异常被 fail-closed 包装成「无有效检视回执」误导排障。修复：改用既有 getRepoRoot()（package.json 锚点逐级向上探测，src 直跑与 dist/src 产物双布局兼容）；既有单测全程 mock execFile 致路径解析从未真实执行是 bug 溜进根因，新增两条回归钉：传给 node 的脚本路径必须 existsSync、固定层数公式在产物布局下锚定错误的反例钉。"
change_type: fix
capability_test: "n/a: 工具内部路径解析，以 merge-pr-tool.test.ts 回归钉（脚本路径真实存在断言 + 旧公式 dist/scripts 错锚反例）+ 全量 vitest 为验证载体"
intent:
  problem: "merge_pr 是搭档授权闸的执行端，检视闭环闸是它在合入前的 fail-closed 物理拦截（保「当前版本被独立检视过」）。闸的实现用固定层数上溯找脚本，但层数假设与真实产物布局差一层——脚本找不到时异常路径与「检视回执缺失」的拒绝文案混叠，排障被引向错误方向（先怀疑检视证书，实际是模块 ENOENT）。既有单测把 execFile 全程 mock，路径计算从未被真实执行，CI 侧闸用的是源目录 scripts/ 路径——三个环境三条路径，只有合入点这条是坏的，且只在真实合入时暴露。"
  solution: "checkReviewClosureOnPr 的 scriptPath 改为 resolve(getRepoRoot(), 'scripts', 'check-pr-review-closure.mjs')——复用既有仓库根定位器（package.json name 锚点逐级向上探测，探测上限 10 级，src 直跑/dist/src 产物双布局兼容，进程内缓存）。移除 fileURLToPath 依赖。回归钉双保险：①端到端断言传给 node 的脚本路径 existsSync（防任何未来的解析回退）；②旧公式反例钉——从模拟产物位置出发，固定 4 层上溯解析到 dist/scripts（不存在），逐级探测解析到真 root（脚本可达），两路径不等。"
  expected_effect: "#1949 关闭标准达成：merge_pr 合入点闸在全新构建（rm dist 后 npm run build）下正常执行，无 Cannot find module；判定拒绝时错误信息反映真实判定结果。所有后续走 merge_pr 的合入不再依赖手动向 dist/scripts 拷贝脚本的临时缓解。"
  verify_by:
    type: behavior_check
    assertions:
      - "merge-pr-tool.test.ts 37/37：新增两钉——「传给 node 的脚本路径经逐级探测解析且真实存在」+「固定层数上溯公式在 dist/src 产物布局下锚定错误」"
      - "npm run build && node <合入点闸同款路径调用> 在全新构建下脚本可达（getRepoRoot 探测不依赖 dist 内部层级）"
      - "全量 vitest 无回归；tsc --noEmit 与 eslint 改动文件零告警"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
tags: [merge-pr, review-closure, script-path, repo-root, layout-compat]
modules:
  - agent-tools
causal_links:
  - {type: "fixes", id: "issue#1949", note: "合入点闸 dist/scripts 路径不存在的首用即崩"}
  - {type: "fixes", id: "healing#4843f98e", note: "high healing 归口事件的正解落地（临时缓解=手动拷贝，本 PR 替换为结构修复）"}
  - {type: "reuses", id: "F20260916repo-root", note: "复用既有仓库根定位器——package.json 锚点逐级探测，双布局兼容"}
  - {type: "hardens", id: "F20261118rvcls", note: "检视闭环闸的合入点执行路径修复——机制不变，定位方式从固定层数升级为逐级探测"}
---

# merge_pr 检视闭环闸脚本路径锚定修复（F20261119mrgsp）

## 事故还原（#1949）

2026-11-19 08:47，搭档授权「1947合入」后调用 merge_pr，被检视闭环闸 fail-closed 拒绝。拒绝文案是「当前 head 未持有有效独立检视通过回执」——但 stderr 尾部混着真实根因：

```
Error: Cannot find module '/Users/orca/ai/otter-buddy/dist/scripts/check-pr-review-closure.mjs'
```

三层环境三条路径，只有合入点这条是坏的：

| 环境 | 路径 | 状态 |
|---|---|---|
| CI 工作流 | `node scripts/check-pr-review-closure.mjs`（源目录） | ✅ |
| 单测 | execFile 全程 mock，路径计算从未执行 | 😶 盲区 |
| merge_pr 合入点 | import.meta.url 固定上溯 4 层 | ❌ dist/scripts 不存在 |

## 根因：层数假设与产物布局差一层

闸的实现假设编译产物在 `dist/interface-adapters/agent-runtime/tools/`（4 层深），上溯 4 层到仓库根拼 scripts/。实际 tsc 布局是 `dist/src/interface-adapters/agent-runtime/tools/`（outDir=dist + rootDir 隐含 src，多一层 src）——上溯 4 层只到 dist/，拼出 `dist/scripts/`，该目录从未被 build 生成。

`npm run build` 只做 tsc（src→dist/src）+ tsc-alias + bge-m3 下载，不拷贝 scripts/——所以 dist/scripts 自闸上线起就不存在。此前所有合入（含 #1928/#1929 自身）都是搭档在 GitHub 手动操作，合入点闸从未真实执行过，#1947 是第一次，首用即崩。

异常被 catch 后统一包装成「检视闭环闸拒绝合入（fail-closed）」——判定文案与真实根因（模块 ENOENT）不一致，排障被引向「补检视证书」的错误方向。

## 修复

### 定位方式：固定层数 → 逐级探测

```ts
// 旧（假设 dist/interface-adapters 4 层，实际 dist/src 5 层，拼出 dist/scripts/）
const scriptPath = fileURLToPath(new URL("../../../../scripts/check-pr-review-closure.mjs", import.meta.url));

// 新（复用既有仓库根定位器：package.json name 锚点，逐级向上探测，双布局兼容）
const scriptPath = resolve(getRepoRoot(), "scripts", "check-pr-review-closure.mjs");
```

`getRepoRoot()`（既有，探测上限 10 级 + 进程内缓存 + 失败退回 cwd）对 src 直跑（vitest）与 dist/src 产物（运行时）双布局等价锚定——未来目录结构调整不破坏定位，这正是它注释里「向上逐级探测比写死层级数更稳」的设计意图。

### 回归钉双保险

既有单测全程 mock execFile 是路径盲区的根因，新增两钉补上：

1. **端到端存在性钉**：跑真实 tool.execute，捕获传给 node 的 args[0]，断言 `existsSync(scriptPath)`——任何未来让路径解析回退的改动立即红。
2. **旧公式反例钉**：从模拟产物位置（dist/src/interface-adapters/...）出发，断言固定 4 层上溯解析到 `dist/scripts/check-pr-review-closure.mjs` 且 existsSync 为 false（错误锚），逐级探测解析到真 root 且脚本可达，两路径不等——把「为什么不能写死层数」钉进测试。

## 临时缓解的退役

事故当场的缓解（手动 `cp scripts/check-pr-review-closure.mjs dist/scripts/`）随本修复合入后退役：不再需要任何手动步骤，`rm dist && npm run build` 的全新构建下合入点闸直接可用。

## Rollback

单函数路径行改动，`git revert <merge-commit>` 即可；回滚后需恢复手动拷贝缓解才能使用 merge_pr。
