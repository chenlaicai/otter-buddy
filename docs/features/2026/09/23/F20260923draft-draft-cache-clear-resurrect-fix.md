---
id: F20260923draft
title: 输入框草稿清空后复活修复
doc_type: feature

summary: |
  修复输入框草稿手动清空后切换页面复活的 bug。
  根因：useEffect cleanup（deps=[draft]）在 draft 每次变化时执行，
  且 React 连续 effect 更新下 cleanup 先于 ref 同步 effect 执行，
  读到滞后的 draftRef.current 旧值写回 localStorage。
  修法：①saveDraft 同步更新 ref（与 clearDraft 同构）；
  ②cleanup deps 收窄为 []（只在真正卸载时执行 flush）。

status: implemented
change_type: fix
tags: [web, ux, fix]
modules:
  - web/src/hooks/use-draft-cache.ts
  - web/src/hooks/use-draft-cache.test.ts

created_in_conversation: 390cc084-03e8-4131-80b7-62e117a84e57
created_at: 2026-09-23T10:05:00+08:00
---

# draft-cache-clear-resurrect-fix

## 问题现象

用户在输入框手动删光内容 → 点击其他页面 → 切回来，草稿复活。

## 根因分析

**机制层**：`use-draft-cache.ts` 的 beforeunload + 卸载兜底 effect（原 `:87-127`）：

1. `useEffect(() => {...}, [draft])` —— deps 含 `draft`，draft 每次变化都触发 cleanup
2. cleanup 里读 `draftRef.current` 写入 localStorage（`:122`）
3. React 连续 effect 更新时序：cleanup（旧 effect）→ ref 同步 effect（`:28`）
4. 用户清空输入框 → `saveDraft('')` → `setDraft('')` 入队 → 渲染后 cleanup 先跑，**此时 `draftRef.current` 还是旧值**（ref 同步 effect 还没轮到）→ 旧值写回 localStorage

**选择性**：`clearDraft()`（发送成功路径）手动同步了 `draftRef.current = ''`（`:70`），所以发送后清除无恙——bug 只咬手动清空路径。

**验证**：trace 测试捕获到 cleanup 在 `saveDraft('')` 后把旧值 `'will-be-cleared'` 写回 localStorage（证据链见对话 390cc084）。

## 修复

两处改动，均为既有机制内修补（Modification-Class: narrow-fix）：

1. **`saveDraft` 同步 ref**（`:48-50`）：`setDraft(text)` 后立即 `draftRef.current = text`，与 `clearDraft` 的既有写法同构。消灭 ref 滞后窗口。
2. **cleanup deps 收窄为 `[]`**（`:113`）：cleanup 只在组件真正卸载时执行（SPA 导航/页面关闭），不在 draft 每次变化时误触发。beforeunload handler 同步改为读 ref 而非闭包 draft（deps=[] 下闭包永远是初始值）。

### Delta（对抗审视后修补）

**S1（严重，检视獭发现）**：上述修复未闭合 300ms debounce 窗口——`saveDraft('')` 空串写入排进 debounce，若用户在 300ms 内导航/关页，unmount cleanup 先取消该 timer、`:122` 因空值跳过写入且不 removeItem → 旧 key 留存 → 复活。

修补：`saveDraft` 空串时同步 `removeItem`（`:63-66`），与 `clearDraft` 完全同构——手动清空语义=立即删除，不等 debounce。

**R1（建议，连带处置）**：测试注释「空串不写入」与行为相反（debounce 回调无条件 `setItem`），已随 S1 修复同步纠正。

## 机制识别检查点（narrow-fix 论证）

逐项过检查点：无新配置项、无新状态字段、无新任务类型、无新存储结构、无新分支逻辑——净新增机制为零。改动均为「在既有赋值点补一次同步」「把 deps 从过宽收窄到正确范围」，属修法决策树①既有机制语义内修补。

## 验证

**失败固化**（修复前红）：`use-draft-cache.test.ts` 新增三个回归测试：
- `should not resurrect manually cleared draft via debounce effect cleanup (ref sync timing)`——cleanup 读滞后 ref 写回路径
- `should not resurrect when cleared and unmounted within debounce window (S1 CE-1)`——300ms 窗口内卸载（SPA 导航）
- `should not resurrect when cleared and beforeunload within debounce window (S1 CE-2)`——300ms 窗口内 beforeunload

**修复后**：11/11 测试全绿（含既有 8 个测试无回归 + 3 个新回归测试）。

## 影响范围

仅 `web/src/hooks/use-draft-cache.ts`（hook 内部时序）+ 测试文件。MessageInput 等消费方无感知——hook 对外接口（`draft`/`saveDraft`/`clearDraft`）签名与语义不变。
