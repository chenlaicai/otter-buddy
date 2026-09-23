## 问题

对话输入框手动删光内容后，点击其他页面再切回来，草稿复活。

## 根因

`use-draft-cache.ts` 的卸载兜底 effect（deps=`[draft]`）在 draft 每次变化时执行 cleanup，且 React 连续 effect 更新时序下 cleanup **先于** ref 同步 effect 执行——cleanup 读到滞后的 `draftRef.current` 旧值写回 localStorage。

时序链：
1. `saveDraft('')` → `setDraft('')` 入队
2. 渲染后 cleanup 先跑，此时 `draftRef.current` 还是旧值 → 旧值写回 localStorage
3. ref 同步 effect 才把 `draftRef.current` 置 `''`——为时已晚
4. 切回来 → 加载 effect 读到旧值 → 复活

`clearDraft()`（发送成功路径）手动同步了 ref 所以无恙——bug 只咬手动清空路径。

## 修复（Modification-Class: narrow-fix）

1. **`saveDraft` 同步 ref**（`use-draft-cache.ts:48-50`）：`setDraft(text)` 后立即 `draftRef.current = text`，与 `clearDraft` 既有写法同构，消灭 ref 滞后窗口
2. **cleanup deps 收窄为 `[]`**（`:113`）：只在组件真正卸载时执行 flush，不在 draft 每次变化时误触发

机制识别检查点逐项过：无新配置/状态/任务/存储/分支——净新增机制为零。

## 验证

- **失败固化**：新增测试 `should not resurrect manually cleared draft via debounce effect cleanup (ref sync timing)`——模拟「写入草稿 → debounce 完成 → 手动清空 → 卸载 → 重新挂载」，断言不复活。修复前红，修复后绿。
- **全量回归**：9/9 测试通过（含既有 8 个无回归）
- **lint/build**：全绿

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
