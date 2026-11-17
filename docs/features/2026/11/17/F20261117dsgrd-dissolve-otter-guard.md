---
id: F20261117dsgrd
title: dissolve_otter 补 big 獭与同对话双重守卫（大獭永远不可解散）
summary: |
  2026-11-16 事故：「端云改造」对话大獭（310e6a9d）在执行审查任务时，按不属本对话的
  ID 调用了 dissolve_otter("87f172c6…")，把「三省吾身」对话的大獭解散了（随后才 dissolve
  系统提示里真正建议处置的小獭 reviewer-delta-1883）。根因：dissolve_otter 工具只有
  「不能解散自己」一道闸，DissolveOtter use case 只查 status（canDissolveOtter）不查 type，
  大獭可被任意路径解散。修法（scope-reduction）：use case 层 type='big' 一律拒绝解散
  （大獭永远保留，任何入口生效）；工具层补同对话范围守卫——目标不在当前对话在场名单
  一律拒绝，防跨对话误杀 small 獭；tool description 同步明示两条边界。事故方 87f172c6
  已恢复（status active + otter_configs 重建）。
change_type: fix
capability_test: "tests/usecases/otter/dissolve-otter.test.ts（big 獭不可解散用例）+ tests/interface-adapters/agent-runtime/tools/dissolve-otter-tool.test.ts（跨对话拒绝/异常转写用例）+ tests/capability/agent-collaboration.capability.test.ts（HTTP DELETE big 獭 → 400 确定性用例）——修复前失败/修复后通过见 Verification"
causal_links:
  relates:
    - "310e6a9d-262d-4b26-8433-e9e758be969b"
    - "87f172c6-3934-4566-a120-b41c19d5b3a1"
    - "#1904"
tags: [otter, dissolve, guard, big-otter, cross-conversation, scope-reduction, incident]
modules:
  - src/usecases/otter/dissolve-otter.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - tests/usecases/otter/dissolve-otter.test.ts
  - tests/interface-adapters/agent-runtime/tools/dissolve-otter-tool.test.ts
  - tests/capability/agent-collaboration.capability.test.ts
created_at: 2026-11-17
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
intent:
  problem: "dissolve_otter 工具与 DissolveOtter use case 只有「不能解散自己」一道闸，无 big 獭类型守卫、无同对话范围守卫——大獭可被任何持 dissolve_otter 工具的獭按不属本对话的 ID 误解散"
  expected_effect: "type='big' 一律拒绝解散（工具/HTTP/清理任何入口）；dissolve_otter 工具对不在当前对话在场名单的目标返回 isError 且不落库；已恢复的 87f172c6 不再可被解散"
  verify_by:
    type: behavior_check
---

# dissolve_otter 补 big 獭与同对话双重守卫

## 现场（2026-11-16 事故）

「端云改造」对话大獭（310e6a9d）在执行审查任务时，按不属本对话的 ID 调用了
`dissolve_otter("87f172c6…")`，把「三省吾身」对话大獭解散了，随后才 dissolve
系统提示里真正建议处置的小獭 `reviewer-delta-1883`（c385d9b8）。时间戳铁证：
- dissolve_otter(87f172c6) 于 06:23:44.962Z
- 中间 06:23:51 的 `get_active_participants` 返回名单不含 87f172c6（证明跨对话）
- dissolve_otter(c385d9b8) 于 06:24:03

后果：87f172c6 的 `otters.status`→dissolved、`otter_configs` 行被删；后续 restart
钻进 `PiSessionFactory.openResetOnlySession` 抛 `Otter config not found` → 500。
已恢复：`otters.status`→active、`dissolved_at`→NULL、重建 `otter_configs` 行。

## 根因

1. **无 big 獭类型守卫**：`DissolveOtter.execute` 只查 `canDissolveOtter(status)`
   （仅 `status === "active"`），不查 `otter.type`——大獭与小獭在同一解散路径上。
2. **无同对话范围守卫**：dissolve_otter 工具只有「不能解散自己」一道闸，LLM 传入
   任何存在的 otterId 都会被执行。
3. 组合后果：一个持 dissolve_otter 工具的大獭，可以按幻觉/误读的 ID 解散任意对话
   的任意獭（含其他大獭），不可逆。

## 修法（scope-reduction）

| 层 | 改动 | 说明 |
|---|---|---|
| use case（dissolve-otter.ts） | `otter.type === 'big'` → 抛 DomainError(validation) | 大獭永远不可解散，任何入口（工具/HTTP/清理）生效 |
| 工具层（tool-factory.ts dissolve_otter） | 先查目标是否 `conversation.participant.getActive` 在场名单，不在场 → errorResponse | 防跨对话误杀 small 獭 |
| 工具层（tool-factory.ts dissolve_otter） | use case 抛 DomainError → 转 errorResponse 不向上抛 | 检视建议：big 守卫在 use case 层，现网不可达但须可读兜底 |
| tool description | 补 BOUNDARY：大獭不可解散 + 目标须同对话在场 | 让 LLM 先知道边界，减少触发 |

设计取舍：类型守卫放 use case 层而非工具层——HTTP `DELETE /api/otters/:id` 与未来
清理路径同享同一道闸，单点不可绕过；范围守卫放工具层——「同对话」是工具调用上下文
才有的信息，use case 无对话概念。

## 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 大獭解散拦截（工具路径） | dissolve_otter({otterId: <big 獭>}) | use case 抛 DomainError(validation)，不落 repo.dissolve、不 destroy agent |
| 大獭解散拦截（HTTP 路径） | DELETE /api/otters/<big 獭> | 400/422，otter 保持 active |
| 跨对话误杀拦截 | dissolve_otter 目标不在当前对话 getActive 名单 | errorResponse(isError=true) 含「跨对话」，不调用 client.otter.dissolve |
| 同对话正常解散 | dissolve_otter 目标在当前对话名单 | 正常调用 client.otter.dissolve |
| 解散自己拦截 | dissolve_otter({otterId: self}) | errorResponse 含「不能解散自己」（既有守卫保持） |

## Verification

### 失败用例证据（bugfix）

**修复前**（origin/main，无 big 守卫）跑新用例 `F20261117dsgrd：big 獭不可解散`：

```
FAIL  tests/usecases/otter/dissolve-otter.test.ts > DissolveOtter > execute() > F20261117dsgrd：big 獭不可解散（大獭永远保留）
AssertionError: expected undefined to be an instance of DomainError
 ❯ tests/usecases/otter/dissolve-otter.test.ts:176:19
     178|       /** 关键：不得落到 repo.dissolve 或 agent.destroy */
 Test Files  1 failed (1)
      Tests  1 failed | 8 skipped (9)
```

（`execute("otter-1")` 对 big 獭 resolve 而非 throw——证明修复前大獭可被解散）

**修复后**：

```
 ✓ tests/usecases/otter/dissolve-otter.test.ts (9 tests) 14ms
 ✓ tests/interface-adapters/agent-runtime/tools/dissolve-otter-tool.test.ts (4 tests) 8ms
 Test Files  2 passed (2)
      Tests  13 passed (13)
```

HTTP 路径端到端（tests/capability/agent-collaboration.capability.test.ts 确定性用例）：
`POST /api/otters`（type=big）→ 201；`DELETE /api/otters/<big>` → 400，otters.status 保持 active。

复现步骤：`cd .otter/worktrees/fix-dissolve-otter-guard &&
npx vitest run tests/usecases/otter/dissolve-otter.test.ts tests/interface-adapters/agent-runtime/tools/dissolve-otter-tool.test.ts`
