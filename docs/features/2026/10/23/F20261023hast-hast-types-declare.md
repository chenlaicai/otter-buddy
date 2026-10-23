---
id: F20261023hast
title: 显式声明 @types/hast 依赖——直接 import 未声明包的脆弱契约收口（#1175，症状不复现的硬化修法）
summary: "#1175 称「MessageList.tsx 引 hast 类型但依赖未声明，基线 tsc 报错」。开工独立核实：npx tsc --noEmit 退出码 0，「基线报错」未复现——@types/hast@3.0.5 经 react-markdown@9.1.0 传递可解析（git log -S 实证自 50ed23b1/2026-08-21 起在 web/package-lock.json）。真实缺陷是脆弱契约：MessageList.tsx:4 直接 import type from 'hast'，类型解析依赖 npm 传递提升，pnpm/yarn-pnp 或依赖树变动即断。按 issue 方案①显式声明 @types/hast@^3.0.5 至 web/package.json devDependencies + lockfile 同步（与现存传递版本一致，diff 2 行插入零删除）。"
change_type: fix
intent:
  problem: "web/src/pages/conversation/MessageList.tsx:4 直接 import type { Element } from 'hast'，但 hast 类型包未在 web/package.json 声明——类型解析依赖 react-markdown 传递提升的 @types/hast，换包管理器（pnpm/yarn-pnp）或依赖树变动即断；issue 描述的『基线 tsc 报错』症状在标准安装下未复现（tsc 0 error）"
  expected_effect: "直接 import 的类型包进入显式依赖声明，环境变化不再能打断类型检查；npx tsc --noEmit 与 npm run build 持续绿"
  verify_by:
    type: behavior_check
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

## 核实（开工前独立核实案发现场）

| issue 断言 | 实测 | 结论 |
|---|---|---|
| 「基线 tsc 即报错（8dc32200 起已存在）」 | `cd web && npx tsc --noEmit` 退出码 0 | **未复现** |
| 「hast 未在 web/package.json dependencies/devDependencies 声明」 | grep 实证属实 | 属实 |
| （隐含）hast 类型无法解析 | `npm ls @types/hast`：react-markdown@9.1.0 → @types/hast@3.0.5（传递）；`git log -S '"@types/hast"' -- web/package-lock.json` → 50ed23b1（2026-08-21）起在 lock | 症状假，缺陷真（脆弱契约） |

## 修法（issue 方案①，优先项）

web/package.json devDependencies 显式声明 `"@types/hast": "^3.0.5"`，package-lock.json 同步（根包 devDependencies 行）。版本与现存传递版本 3.0.5 一致，npm dedupe 后单版本，diff 共 2 行插入零删除。

方案②（内联类型 / 从 rehype 侧取）不取：@types/hast 是 hast 节点类型的事实来源（react-markdown 生态同源），显式声明比内联拷贝更不易漂移。

## Verification

- `npx tsc --noEmit` → 0 error（修复前后均过——硬化收口无可固化失败态，失败用例证据豁免记录：症状在标准安装下不复现，无失败测试可固化）
- `npm run build` → exit 0
- `npm ls @types/hast` → 3.0.5 单版本 dedupe
