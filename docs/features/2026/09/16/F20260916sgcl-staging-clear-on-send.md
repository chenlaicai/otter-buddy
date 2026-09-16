---
id: F20260916sgcl
title: 附件中转区发送后不清空修复（悬浮截图发送后不消失）
summary: 发送链路绕过 takeForSend/clearAll，中转区 staged 状态无复位入口，发送后悬浮缩略图残留且会被下一条消息重复携带；在 ChatView 包一层 onSend，成功后 clearAll
change_type: fix
status: implemented
tags: [web-ui, multimodal, attachments, bugfix]
modules: [web/src/pages/conversation/ChatView.tsx, web/src/pages/conversation/ChatView.test.tsx]
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

在 ChatView（staging hook 持有者）包一层 `handleSendWithStaging`：

```ts
function handleSendWithStaging(text, mentionOtterIds?, attachments?, mode?) {
  try {
    props.onSend(text, mentionOtterIds, attachments, mode)
    staging.clearAll()
  } catch (err) {
    showToast(..., 'error')
  }
}
```

- 选 `clearAll` 而非 `takeForSend`：MessageInput 已把 attachments 作为参数传出，`takeForSend` 的返回值无人消费、其上传中/图片上限校验属冗余（canSend 已挡 uploading 态）；`clearAll` 语义恰好是「清空+释放 blob+清错误」
- 失败路径（onSend 同步抛错）不清空，保留附件供用户重试
- MessageInput props 契约不变

### 备选方案（未选）

MessageInput 层调 `takeForSend()` 替代直接读 `staged`：需改 props 契约（传入 takeForSend 而非 staged），且 takeForSend 依赖 staged 闭包（useCallback([staged])），调用时序上比 clearAll 更绕。接线更长，无收益。

## 验证

- 新增 ChatView.test.tsx 两条回归（MessageList stub 掉，聚焦输入区与中转区联动）：
  1. 粘贴截图 → 中转区出现缩略图 → 点发送 → onSend 携带附件 + 中转区 DOM 消失
  2. onSend 抛错 → 中转区保留供重试
- web 全量 conversation 测试：18 文件 175 条全绿
- `tsc --noEmit` 干净

## 影响范围

- 仅 web 前端 ChatView 发送路径；后端与消息渲染不变
- 卡片提交链路（useCardBridge → handleSend）不经 ChatView 包装层（它不携带附件），行为不变
