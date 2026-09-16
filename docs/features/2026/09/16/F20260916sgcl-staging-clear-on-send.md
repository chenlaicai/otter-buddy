---
id: F20260916sgcl
title: 附件中转区发送后不清空修复（悬浮截图发送后不消失）
summary: 发送链路绕过 takeForSend/clearAll，中转区 staged 状态无复位入口，发送后悬浮缩略图残留且会被下一条消息重复携带；在 ChatView 包一层 onSend，成功后 clearAll
change_type: fix
status: implemented
tags: [web-ui, multimodal, attachments, bugfix]
modules: [web/src/pages/conversation/ChatView.tsx, web/src/pages/conversation/ChatView.test.tsx, web/src/pages/conversation/index.tsx]
from: [F20260828mmwb]
supersedes: []
created_in_conversation: 1bed6225-ca6b-43c0-8504-b2209041b26a
---

# 附件中转区发送后不清空修复（悬浮截图发送后不消失）

## 背景（意图锚）

搭档原话：「输入框放入截图后，截图会悬浮在输入框上方，然后点击发送，这个悬浮的截图不会消失，就很诡异奇怪」

## 根因

附件中转区（staged 缩略图悬浮区，F20260828mmwb 引入）的清空入口有且仅有两个：
- `useAttachmentStaging.takeForSend()`（useAttachmentStaging.ts:96）——发送时提取并 `setStaged([])`
- `useAttachmentStaging.clearAll()`（useAttachmentStaging.ts:114）——会话切换 effect 自动调用

但实际发送链路完全绕过两者：

1. `MessageInput.handleSend`（MessageInput.tsx:81）直接把 `staged` 数组原样传给 `onSend`，只清了文本草稿（`clearDraft()`），不碰附件状态
2. `ChatView.tsx:131` 将 `props.onSend` 原样透传给 MessageInput
3. `index.tsx handleSend`（index.tsx:767）消费 attachments 发请求，无回调清空 staging

全仓 grep 证实：`takeForSend` 除自身测试外无任何生产调用方——机制写好了但接线漏了。消息本身能正常带附件发出（后端收到 attachmentIds、气泡渲染附件），纯粹是中转区 UI 状态无复位入口。

**次生危害**：发送后 staged 残留 → `canSend` 中 `staged.some(s => !s.uploading)` 恒为 true → 下一条纯文本消息会重复携带同一附件（attachmentIds 重发）。

## 修法排序

走修法排序①（既有机制语义内修）：`takeForSend`/`clearAll` 机制本身设计正确，缺的只是发送链路的调用接线。命中机制识别检查点零项（无新配置/状态/存储/分支），不涉净新增机制。

Modification-Class: narrow-fix

## 方案

在 ChatView（staging hook 持有者）包一层 `handleSendWithStaging`，**await 到 Promise 落定再 clearAll**（初版同步调用被检视獭 S1 发现打回，见下「审视处置」）：

```ts
async function handleSendWithStaging(text, mentionOtterIds?, attachments?, mode?) {
  try {
    await props.onSend(text, mentionOtterIds, attachments, mode)
    staging.clearAll()
  } catch {
    // 发送失败：附件保留在中转区供重试（toast 已在 handleSend 内部出过）
  }
}
```

配套修改 `index.tsx handleSend`：两个失败出口（`!response.ok`、`catch` 网络错误）原来只 toast 不抛出，调用方无法区分成败——改为 rethrow（202 halted 分支不抛：消息已送达被拦截，语义成功，清空中转区正确）。

- 选 `clearAll` 而非 `takeForSend`：MessageInput 已把 attachments 作为参数传出，`takeForSend` 的返回值无人消费、其上传中/图片上限校验属冗余（canSend 已挡 uploading 态）；`clearAll` 语义恰好是「清空+释放 blob+清错误」
- 失败路径（onSend reject）不清空，保留附件供用户重试
- 错误 toast 只在 index.tsx 内部出，ChatView catch 块不重复提示（F1）
- MessageInput props 契约不变；ChatView 的 onSend 类型改为 `void | Promise<void>`

### 备选方案（未选）

MessageInput 层调 `takeForSend()` 替代直接读 `staged`：需改 props 契约（传入 takeForSend 而非 staged），且 takeForSend 依赖 staged 闭包（useCallback([staged])），调用时序上比 clearAll 更绕。接线更长，无收益。

## 审视处置

检视獭-993（mimo 模型）初轮结论 request-changes，1 严重 2 建议，全部接受并本 PR 修复：

- **S1（严重）**：`props.onSend` 实为 async（index.tsx handleSend），同步调用 + try/catch 只捕获同步错误；sendMessage 网络失败时 clearAll 已执行、blob 已 revoke、附件无法重试——恰好违背「失败保留重试」意图。且 index.tsx catch 吞掉异常不 rethrow，即使 await 也感知不到失败。→ 修复：handleSend 失败两路 rethrow + ChatView 改 await 形态
- **F1（建议）**：原 catch 块 showToast 与 index.tsx 内部 toast 重复 → ChatView catch 改为空块（toast 统一由 handleSend 出）
- **F2（建议）**：测试原用 `vi.fn(() => { throw })` 只覆盖同步抛错 → 改为 `mockRejectedValue` 覆盖真实异步失败路径

## 验证

- 新增 ChatView.test.tsx 两条回归（MessageList stub 掉，聚焦输入区与中转区联动）：
  1. 粘贴截图 → 中转区出现缩略图 → 点发送 → onSend 携带附件 + 中转区 DOM 消失
  2. onSend 异步 reject（mockRejectedValue，真实失败路径）→ 中转区保留供重试
- web 全量 conversation 测试：18 文件 175 条全绿
- `tsc --noEmit` 干净

## 影响范围

- 仅 web 前端 ChatView 发送路径；后端与消息渲染不变
- 卡片提交链路（useCardBridge → handleSend）不经 ChatView 包装层（它不携带附件），行为不变
