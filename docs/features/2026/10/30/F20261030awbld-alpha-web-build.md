---
id: F20261030awbld
title: "alpha.sh 构建段补 web 构建：修复验证环境跑旧前端的隐蔽失效（#1601）"
summary: "issue #1601 原判「根 build 不清 web/dist 致多代残留」经实测推翻：vite emptyOutDir 默认正常清空（stale 探针 rebuild 后被清），单次构建 9-10 个 index-*.js 是 React.lazy 代码分割正常形态（非多代残留）。真因：alpha.sh 构建段只跑后端 build，从不构建 web——而 app.ts 的静态 serve 指向 worktree/web/dist（import.meta.dirname 相对解析），改前端后 alpha 静默 serve 旧/缺失前端 = 「改了不生效、无报错」。修复：alpha.sh 构建段补 web 构建（非 --quick 全量构建、--quick 时 web/dist 缺失兜底、失败 die 拒启）。"
change_type: fix
capability_test: "n/a: 构建脚本语义补全（被修对象即构建流程），以本节 Verification 证据链为验证载体"
intent:
  problem: "alpha 验证实例的构建链缺前端半截：scripts/alpha.sh 的构建段只跑后端 npm run build（tsc→dist），从不构建 web；而 src/app.ts 的静态 serve 路径是 worktree/web/dist（import.meta.dirname 相对解析）——开发者改前端代码后 alpha.sh start 只重建后端，serve 的是旧的甚至缺失的 web/dist，表现为「功能改了不生效、Console/Network 无报错」的隐蔽失效（issue #1601 现场：3102 实例 game 产物卡不渲染）。原 issue 根因判断（「根 build 不清 web/dist 多代残留」）经实测不成立，属对单次构建代码分割 chunk 群的误读。"
  solution: "alpha.sh 构建段补 web 构建，与后端同语义：非 --quick 全量构建 web（cd web && npm run build）；--quick 时 web/dist 缺失才兜底构建；构建失败 die 拒启（对齐脚本『宁可不启动』哲学——带旧前端启动比不启动更害人）。"
  expected_effect: "alpha.sh start 后 worktree/web/dist 恒为新鲜构建，前端改动真实生效；web 构建失败时拒启动而非静默带旧前端，隐蔽失效通道关闭。"
  verify_by:
    type: behavior_check
    assertions:
      - "修复后实测：web/dist 缺失状态下 alpha.sh start --port 3110 → 构建段产出 web/dist（index.html + 17 assets）→ curl / 200 且 index.html 引用的 chunk 在新产物中 → alpha.sh stop 正常"
      - "机理修正证据：stale 探针实验（塞 stale-*.js 后 rebuild 被清，emptyOutDir 正常）+ 单次构建产出 10 个 index-*.js（代码分割正常形态）——原『多代残留』判读不成立"
      - "修复前行为：旧构建段无 web 步骤（diff 事实）+ issue #1601 现场实录（3102 实例改前端不生效）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [alpha, build, web-dist, hidden-failure]
modules:
  - ci
---

# alpha.sh 构建段补 web 构建（#1601）

## 根因修正说明（先于修复陈述，因为 issue 原根因被实测推翻）

issue #1601 原判「根 build 不清 web/dist → 多代构建残留，index.html 引用过期 bundle」。实测两条：

1. **vite emptyOutDir 默认正常工作**：web build 后塞 `stale-probe-TESTONLY.js` 进 dist/assets 再 rebuild → 探针被清（18→17 文件）。「多代残留」在标准 vite build 流程下不可能产生。
2. **「9 个 index-*.js」是单次构建的正常形态**：vite.config.ts 无 build 定制、路由级代码分割（React.lazy）使每个懒加载路由都产出一个 `index-*.js` chunk——实测单次构建产出 10 个 index-*（css+js）。当时把代码分割 chunk 群误读为「多代残留」。

仓内亦无其他 web/dist 写入路径（scripts/.github 均无引用，alpha.sh 不碰 web）。

## 真因

`src/app.ts:669`：静态 serve 根 = `path.resolve(import.meta.dirname, "../..", "web/dist")`——相对编译产物 dist/src 解析，即 **worktree/web/dist**。而 alpha.sh 构建段只跑 `npm run build`（后端 tsc→dist）。改前端 → `alpha.sh start` → serve 旧/缺失 web/dist → 隐蔽失效。issue 的现象（改前端不生效、无报错）与此机理 100% 吻合，且「重新 build 后验证前端行为被坑」的体感正来自「build 的是后端」。

## 修法

alpha.sh 构建段后追加 web 构建（与后端同语义）：

- 非 `--quick`：`cd web && npm run build`，失败 `die` 拒启（带旧前端启动比不启动更害人，对齐脚本 config 硬校验的『宁可不启动』哲学）
- `--quick`：web/dist 缺失才兜底构建（对齐后端 quick 语义）
- 失败报错含排障提示（`cd web && npm install`）

Modification-Class 判定：**narrow-fix**（修法决策树①既有语义内修）——「alpha start=完整可用的验证环境」是脚本既有承诺，构建段缺前端半截属语义漏洞补全，零新机制。

## Verification（证据链）

**修复后通过（实测）**：

```
start 前：web/dist 缺失（已 rm -rf 清空，现场可复现）
$ bash scripts/alpha.sh start --port 3110
Alpha started (PID 2953) -> http://localhost:3110
$ ls web/dist/index.html            → ✅ 存在（17 assets 全量构建）
$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3110/  → 200
$ ls web/dist/assets/index-BkkMJvel.js  → 存在（index.html 引用的 chunk 在新产物中）
$ bash scripts/alpha.sh stop        → Stopped.
```

**修复前失败**：旧构建段无 web 步骤（diff 事实，见 PR）+ issue #1601 现场实录（3102 实例改前端不生效）。

**机理修正证据**：stale 探针实验（emptyOutDir 正常）+ 单次构建 10 个 index-*（代码分割形态）。

## 影响范围

`scripts/alpha.sh` 一处（构建段追加）。alpha start 变慢（多一次 web build ~9s）；web 依赖缺失时 alpha 拒启（此前静默降级——行为变化是修复目的）。
