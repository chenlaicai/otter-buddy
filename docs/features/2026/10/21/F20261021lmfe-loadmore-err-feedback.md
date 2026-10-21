---
id: F20261021lmfe
title: loadMoreBefore 加载历史失败态用户反馈（按钮错误态 + 重试入口 + 自动通道防重试风暴）
summary: loadMoreBefore 失败时按钮进入「加载失败，点击重试」错误态，哨兵自动通道失败仅按钮体现不打断阅读，并阻断失败后 IO 重挂引发的隐性重试风暴。
change_type: fix
capability_test: "n/a: web UI 纯运行时反馈态改动，无 prompt/协议行为语义，golden 无对应场景"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-21
modules:
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/ChatView.tsx
  - web/src/pages/conversation/MessageList.tsx
tags:
  - issue-1581
  - error-feedback
  - pagination
---

# F20261021lmfe loadMoreBefore 加载历史失败态用户反馈

## 背景（issue #1581）

`loadMoreBefore`（web/src/pages/conversation/index.tsx）的 catch 块此前只 `console.error`——
加载历史失败（网络断/服务端错/游标失效）时用户零感知：按钮/哨兵仍在、无报错、无重试提示，
用户表现为「点加载更多没反应」（自动通道下是「上翻到底历史凭空停止」，无法区分
「历史拉完了」与「加载失败了」）。

## 实现

三个文件沿既有 prop 透传模式（与 `loadingMore` 同款），无接口签名变更：

1. **index.tsx**：新增 `loadMoreError` state；`loadMoreBefore` 开头清错（重试语义），
   catch 置错；切会话 effect 清错（错误属于上一会话那次请求，不阻断新会话自动通道）
2. **ChatView.tsx**：prop 透传
3. **MessageList.tsx**：
   - 手动按钮错误态：文案「加载失败，点击重试」+ 红调样式，保持可点击（重试入口）
   - 哨兵 IO 回调在 `loadMoreError` 时阻断自动通道

## 设计取舍

- **反馈形态取「按钮错误态」而非 toast**：关闭标准（issue）为「toast 或按钮错误态」二选一；
  按钮错误态对两个通道统一生效且在用户视线内，无接口签名变更（区分通道发 toast 需给
  `onLoadMore` 加 source 参数，跨三文件改签名）——最简路径达成全部关闭标准。
  哨兵自动通道失败不弹窗不打断阅读，仅按钮体现（issue 修复方向要求）。
- **自动通道阻断防重试风暴**（issue 未列、排查发现的同模块隐性缺陷）：哨兵重挂后
  IntersectionObserver 初始回调必 fire 一次，原实现下失败→`loadingMore` 翻转→effect 重跑
  （deps 含 loadingMore）→IO 重挂→再拉，形成隐性重试循环（靠 `AUTO_CHAIN_MAX_BATCHES`
  冷却限幅止血）。错误态阻断自动通道后循环消失，解除只走手动按钮点击（重试语义）。
- **机制判定（issue 驱动、未经 requirement-analysis，动手前判定）**：机制识别检查点
  七项逐条不命中——`loadMoreError` 是组件内 React 临时 UI 态（与 `loadingMore` 同类），
  无持久化、无新配置/枚举/定时任务/信号格式、决策分支纯运行时临时（不落库不影响后续
  跨会话行为）、调用路径沿既有 prop 透传。判定结论：走修法决策树①（既有语义内修），
  `narrow-fix`。
- **哨兵失败与手动失败反馈一致**：不做通道区分（见上「最简」理由），两通道失败统一
  按钮错误态。

## 关闭标准对账（issue #1581）

| 关闭条款 | 落点 | 验证 |
|---|---|---|
| 失败时用户可获得明确反馈（toast 或按钮错误态） | 按钮「加载失败，点击重试」红调错误态 | 集成用例断言错误反馈元素出现 |
| 重试入口可用 | 错误态按钮保持可点击，点击清错重试 | 集成用例断言重试成功 prepend 历史 |
| 哨兵自动通道失败不阻断当前阅读位置 | 不动滚动、不弹窗，仅按钮体现 | MessageList 用例断言 error 态自动通道静默 |

## 验证

**验收标准断言化**（场景/操作/预期）：

| 场景 | 操作 | 预期结果 |
|---|---|---|
| before 游标请求 500 | 点「加载更早消息」 | 按钮变「加载失败，点击重试」且可点（PASS，index.loadmore-error.test.tsx） |
| 失败后重试 | 点错误态按钮，服务端恢复 | 历史 prepend、按钮退出错误态、入口卸载（hasMore=false）（PASS） |
| 失败态哨兵触发 | fireSentinel(true) | 自动通道不触发 onLoadMore（PASS，MessageList.test.tsx） |
| 失败态手动点击 | 点错误态按钮 | onLoadMore 触发（重试入口）（PASS） |
| error 清除 | 重新渲染 loadMoreError=false | 按钮恢复常态文案、自动通道恢复（PASS） |

**失败证据链**（bugfix 硬规则）：上述 2 个新用例在实现前跑为红（2 failed | 26 passed，
失败点正是「错误反馈元素 undefined」与「按钮文案非错误态」），实现后 28/28 全绿；
全量 web 测试 734/734 绿（无回归）。

**最简检查**：已过最简检查——复用既有 `loadingMore` prop 透传模式与按钮渲染点，
无新依赖/无新组件/无接口签名变更；备选的 toast+source 参数方案因需改三文件签名被弃。

**负面向条目**（本次变更破坏了什么旧契约）：哨兵自动通道新增 `loadMoreError` 阻断——
原契约「哨兵 intersecting 即尝试加载」在失败态下收窄为不自动重试；换取的是隐性重试
风暴消失，解除路径显式化（手动点击）。既有测试无覆盖该隐性循环的用例，无旧断言被破坏。
