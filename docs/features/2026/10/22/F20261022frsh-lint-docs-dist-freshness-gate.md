---
id: F20261022frsh
title: 'lint:docs dist 新鲜度闸（#1400）：src 修改晚于 dist 构建即报错，封死陈旧 dist 假绿'
summary: |
  #1400 修复：lint-docs.mjs 动态 import dist/ 编译产物，本地 dist 停在旧 commit 时跑
  lint:docs 用旧 validator 假绿（不含新规则），误导预检判断，CI fresh build 才报红返工
  （PR #1397 实证）。修复：新增 dist 新鲜度闸（evaluateDistFreshness 纯函数）——
  validator/parser 源目录任一 .ts 修改时刻 >= dist 产物最早写入时刻即判 dist 陈旧，
  import 前报错提示 rebuild（fail-closed 等号保守判陈旧）。目录级对比（非依赖图）：
  validator 新增 import 自动入列无需维护清单，误报方向安全（多一次 rebuild 提示），
  假绿方向被闸死。pre-commit/CI 不受影响（都在 build 后跑，dist 恒新鲜）。
  5 个新增测试锁定判据。
change_type: fix
capability_test: tests/lint/lint-docs.test.ts
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
intent:
  problem: "lint:docs 复用 dist/ 编译产物但无新鲜度防护：本地 dist 陈旧时跑 lint:docs 用旧 validator 假绿，误导预检判断（本地绿 ≠ CI 绿，#1400 现场返工一轮）"
  expected_effect: "dist 陈旧（src 修改晚于构建）时 lint:docs 拒绝运行并报错提示 rebuild（exit 1）；build 后的正常路径（pre-commit/CI）行为不变仍绿；假绿场景从「静默通过」翻转为「显式拦截」"
  verify_by:
    type: behavior_check
---

# lint:docs dist 新鲜度闸（#1400）

## 问题与现场

issue #1400（2026-10-09 立案，来源 PR #1397 检视附注）：`lint-docs.mjs:62-70` 动态 import
**dist/** 下的 frontmatter-validator——本地 dist 陈旧（未重新 build）时跑 `npm run lint:docs`
会**假绿**（用的是旧 validator 逻辑，不含新规则），误导「预检干净」判断；实际 CI（fresh
build）报红，来回返工一轮（855fb6bd→4a952d40）。

**本次修复前复现（失败证据，worktree 内实录）**：

```
$ touch src/entities/document/frontmatter-validator.ts ... # mtime 推新模拟「src 修改晚于 dist 构建」
$ stat: src ... 11:55:01 / dist ... 11:54:43   ← dist 陈旧形态
$ node scripts/lint-docs.mjs
⚠ F20261020lmld
    Unknown change_type: bugfix
[lint:docs] 1 warnings（不阻断 commit，上限 3）
[lint:docs] 871 docs OK
exit=0            ← 假绿：陈旧 dist 无任何提示，静默通过
```

**修复后同现场（拦截证据）**：

```
$ node scripts/lint-docs.mjs
✗ [lint:docs] dist/ 产物陈旧（#1400 假绿防线）：src/usecases/document/frontmatter-parse.ts 的修改未进构建，当前跑的是旧 validator 逻辑，结果不可信（本地绿 ≠ CI 绿）
  请先 `npm run build` 重新构建后再跑 lint:docs。
exit=1
```

**假绿的作用面边界（排查确认）**：pre-commit 路径不受影响——hook 里 `npm run check`（第一步
build）先于 `npm run lint:docs`，dist 恒新鲜；CI（`.github/workflows/ci.yml:123-125`）同理在
build 后跑。假绿只发生在**绕过 pre-commit 的本地手动预检**（开发者 push 前手动跑
`npm run lint:docs` 自查）——恰是 issue 现场。

## 方案设计（三候选定案）

| 候选 | 内容 | 判定 |
|---|---|---|
| A-1 | lint:docs 前强制增量 build validator | 弃：lint 工具静默触发 build 过重（build 含 bge-m3 下载副作用）；增量 build 需另立 tsconfig |
| **A-2（采纳，issue 方案 A 第二形态）** | **校验 dist mtime vs src mtime，陈旧即报错提示 rebuild** | **零新依赖、~15 行、fail-closed** |
| A-3 | build 时写 src hash manifest，lint 对比 | 弃：要挂 postbuild 钩子 + manifest 生命周期管理，~40 行，精确性收益（对抗 mtime 精度）不值 |
| B | validator 改 src 直跑（tsx/esbuild-register） | 弃：**引入新依赖**（devDeps 无 tsx/esbuild）；Node 24 原生 type stripping 卡在 src 无扩展名 import（`from "./known-values"` 需 `.ts` 后缀），改 import 面波及全构建配置 |

mtime 判据可靠性论证（A-2 的成立前提）：git 只在**内容变化时重写文件**（mtime 更新）——pull/checkout
拉到的 src 变化必然刷新 mtime，抓得到；内容未变的 checkout 不重写不误报。touch 类人为刷新
mtime 误报方向安全（让人 rebuild，不产生假绿）。唯一已知边界：build 进行中改 src 的竞态
（src mtime 可能早于 dist 最晚产物）——人不在 build 进行中改代码，且产物本身已不确定，
不设防。

## 设计取舍

**机制识别检查点判定（issue 驱动，动手前完成）**：七项全未命中——不新增配置/枚举/开关、
无状态生命周期、无定时任务、无信号格式、无持久化存储、无「被记住的决策分支」（新鲜度判断
是纯运行时临时分支，不落库不落记忆）、无跨模块调用路径（lint-docs.mjs 内部 fs.statSync）。
→ 默认走修法决策树①（既有机制语义内修：lint:docs 的既有语义是「用 dist 校验 docs」，缺的
是「dist 可信前提」，补防护即缺啥补啥）→ **Modification-Class: narrow-fix**。

**为什么取目录级对比而非依赖图级**：依赖图级（精确追踪 validator 的 import 闭包）要维护
清单或解析模块图（~40-60 行）；目录级（src/entities/document + src/usecases/document 两个
源目录整体 vs dist 对应产物）零维护——validator 未来新增 import 自动入列。代价是误报面
略宽（改了 validator 不依赖的同目录文件也报陈旧），但误报成本 = 一次多余的 rebuild 提示，
方向安全（fail-closed），假绿方向被闸死。

**为什么是报错提示而非自动 build**：lint 工具静默改环境（触发 build）会让 lint 行为不可预测
且重（build 含全量 tsc + bge-m3 下载）；报错 + 明确指引（`npm run build`）符合 lint gate
语义，pre-commit/CI 场景根本不会走到报错分支。

## 验收标准（机械断言）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 假绿现场（issue 复现） | build 后 touch src/entities/document/frontmatter-validator.ts，跑 `node scripts/lint-docs.mjs` | exit 1 + 「dist/ 产物陈旧」报错 + 提示 `npm run build` |
| 常规新鲜态（pre-commit/CI 路径） | `npm run build && npm run lint:docs` | exit 0 + 「871 docs OK」（既有行为不变） |
| dist 未构建 | 删 dist/ 后跑 `node scripts/lint-docs.mjs` | exit 1 + 既有「dist/ 未构建」报错（新鲜度闸不抢戏，skipped） |
| 判据单测 | `npx vitest run tests/lint/lint-docs.test.ts` | 10 passed（5 既有 + 5 新增：陈旧/新鲜/等号边界/极值取法/skipped） |
| pre-commit 全链 | `npm run check && npm run lint:docs` | 全绿（check 的 build 先行，新鲜度闸恒通过） |

## 验证

- **失败证据链（bugfix 硬规则）**：修复前假绿输出 + 修复后拦截输出见「问题与现场」节实录
  （同一陈旧现场，exit 0→1 翻转）；判据行为由 5 个新增单测锁定（修复前 evaluateDistFreshness
  不存在 = 测试无法通过）。
- **测试**：`npx vitest run tests/lint/lint-docs.test.ts` → 10 passed（303ms）。
- **全链自检**：`npm run check`（build + lint + lint:schema + smoke:boot + test:script-arg-parse）
  全绿；check 后 `npm run lint:docs` 绿（= pre-commit 实际序列）。
- **最简实现检查**：已过阶梯——仓库已有实现（walk 递归复用，参数化 ext）→ stdlib（node:fs
  statSync）→ 零新依赖零新文件（纯函数 + main 接线 + 测试，改动 3 文件）；确认已最简
  （比 hash manifest 少 ~25 行，比 src 直跑少 1 个依赖）。
- **影响面当场自检**：lint-docs.mjs 头部注释「依赖：pre-commit hook 已跑 npm run check」
  同步补新鲜度闸说明（本 PR 内改）；既有 walk() 调用签名加默认参数 ext=".md"，两处调用
  零改动兼容。
