---
id: F20260829gvid
title: "create_linked_resource groupId 必填校验——pr/worktree/branch 三类产物强制分组"
summary: 工具层 + domain 层双层校验：创建 pr/worktree/branch 类型资源时 groupId（特性文档编号）必填，漏传报错。fact/url/file 维持可选。
change_type: feature
status: active
created_at: 2026-08-29
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
intent:
  problem: "create_linked_resource 建产物时 groupId 漏传无校验、事后无 update 接口，只能 supersede+重建补救。gssf（PR #556）/ptun（PR #561）两次连续案例都是检视獭抓到才补，LLM 会忘是实证不是假设。"
  expected_effect: "漏传在创建时即被拦截（带明确指引的错误消息），不再依赖检视环节兜底；B4 变更标识一致性检查的 groupId 维度由工具层守卫。"
  verify_by:
    type: behavior_check
    detail: "A 类纯代码逻辑（确定性输入输出），双层校验各配单测：domain 层 6 用例（tests/usecases/conversation/manage-key-info.test.ts）+ 工具层 4 用例（tests/interface-adapters/create-linked-resource-tool.test.ts），全量 2073 tests 通过。"
capability_test: "n/a: 纯 A 类校验逻辑（domain + tool 层确定性输入输出），无 LLM 行为参与"
tags: [artifact, validation, group-id]
modules: [src/usecases/conversation/manage-key-info.ts, src/interface-adapters/agent-runtime/tools/tool-factory.ts]
---

# create_linked_resource groupId 必填校验

## 背景

issue #580（检视獭-ptun 收尾观察，fact 1963898e）：`create_linked_resource` 建产物时 groupId 漏传无校验，两次连续案例（F20260828gssf / F20260828ptun）都是检视环节抓到后 supersede+重建补救。

groupId = 特性文档编号（如 F20260828ptun），漏传导致 `list_artifacts?groupId=Fxxx` 检索落空，B4 变更标识一致性检查的 groupId 维度失守。

## 方案

issue #580 二选一中的**方案 A（工具层校验）**，搭档拍板执行（2026-08-29）。

### 设计决策

**D1 校验范围 = pr / worktree / branch 三类**。这些类型是「一次特性交付」的组成产物，天然有组。fact（散点事实）、url（外部链接）、file（临时/研究文件）可独立存在，维持可选——F20260821 的实践里 file/url 有大量无组用法（评估报告、研究文件），强制会误伤。

**D2 双层校验，domain 层为准**。与 fact 长度校验同型（F20260807factlim 先例）：domain 层 `validateGroupIdRequired` 抛 DomainError（HTTP/API 路径与所有调用方全覆盖），tool 层镜像校验返回友好错误消息（LLM agent 拿到可行动的指引而不是 DomainError 栈）。共享常量 `GROUP_ID_REQUIRED_TYPES` / `GROUP_ID_REQUIRED_MESSAGE_PREFIX` 保证口径一致。

**D3 supersede 路径校验 effective groupId**。「无 groupId 重建 + supersede」是漏传的既定补救路径（ptun 案例实际用过，bootstrap/clients.ts `resource.supersede` 调用链）——新输入缺 groupId 时继承旧资源的组（buildResource 既有 fallback 语义），只有新旧都无组才拒绝。一刀切在 validateInput 里会把合法补救路径打断。

**D4 纯空白视为漏传**。`"   "` trim 后为空按缺失处理，与 fact content 校验口径一致。

### 改动清单

| 文件 | 改动 |
|---|---|
| `src/usecases/conversation/manage-key-info.ts` | `GROUP_ID_REQUIRED_TYPES` 常量 + `validateGroupIdRequired` 函数；`linkResource` 强制校验；`supersedeResource` 校验 effective groupId（新输入 ?? 旧资源组） |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 工具层镜像校验（错误消息含指引 + #580 锚点）；`groupId` 参数描述标注必填类型；工具 description 加 GOTCHA |
| `tests/usecases/conversation/manage-key-info.test.ts` | +6 用例：worktree/branch 拒绝、pr 通过、fact/url/file 可选、supersede 继承放行、supersede 双无组拒绝 |
| `tests/interface-adapters/create-linked-resource-tool.test.ts` | +4 用例：缺 groupId 报错、空白视为漏传、带 groupId 通过、url 可选 |

## 验证

- domain 层单测 19/19（含 6 新用例），工具层单测 8/8（含 4 新用例）
- `npm run build` 通过；`npm test` 全量 176 files / 2073 tests 通过
- 已过最简检查：校验逻辑复用 fact 长度校验的既有模式（常量导出 + 双层调用），无新增依赖，无新文件——最简路径

## 后续

- issue #580 本 PR 关闭（Fixes #580）
- 观察点：若未来出现「无特性文档的一次性产物」被误拦，可在错误消息指引里补「先建 F 文档再登记」的话术——当前三类都是流程内产物，预期不触发
