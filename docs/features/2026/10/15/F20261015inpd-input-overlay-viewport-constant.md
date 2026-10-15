---
id: F20261015inpd
title: 输入框覆盖层：消息列表视口高度恒定，根治输入跳动
doc_type: feature
created: 2026-10-15
created_in_conversation: f8487cf6-2253-4833-9d77-155973607375
tags: [web, scroll, bugfix, layout, design-principle]
change_type: fix
capability_test: web/e2e/scroll-pin-frame-guard.spec.ts
summary: |
  搭档 10-15 报告「输入多行时中间栏消息上下跳动」（10/10 F20261010vwst 修复后仍有残余）。
  探针实测复现：输入框从 24px 长到 140px 过程中视口被压缩 104px，scrollTop 累计 clamp
  损失在封顶帧一次性补回（+104px 跳变）。第一性原理：「枚举补偿源」永远枚举不完——
  根治需让输入框和消息列表视口解耦。落地覆盖层方案：输入框 absolute 悬浮底部脱离文档流，
  消息列表 padding-bottom 预留空间，视口高度恒定。
causal_links:
  from:
    - F20261010vwst
    - F20261008scpg
---

## 1. 背景与问题现象

10/15 11:14 搭档报告：「输入多行时，中间栏的消息一直在上下滚动」——10/10 第 9 轮修复（删 viewportObserver）后仍有残余。

**探针实测复现**（Playwright 逐帧采样，搭档真实服务 localhost:3000）：

```
帧208: top=11161  tah=140  taSh=159  styleH=140px  ← 输入框到 140px 封顶
帧209: top=11265  tah=140  taSh=159  styleH=140px  ← 同一内容，scrollTop 跳 +104px
```

**机制链**：
1. 输入框从 24px 长到 140px，视口（消息列表容器）被压缩 104px
2. 压缩过程中浏览器 clamp 让 scrollTop 被动下移（内容看起来在往下沉）
3. 到 140px 封顶帧，之前累计的 clamp 损失一次性补回 → 视觉上是「突然跳回」
4. 搭档看到的「往上一行往下一行」= 输入框每长一行视口压一行（内容沉一行），封顶帧一次性补回

**为什么 10/10 修复没防住**：删 viewportObserver 时假设「浏览器 clamp 天然保证稳定」，但实测发现 clamp 是渐进式的——中间过程用户看到的就是「内容在往下沉」，最后一下跳回是「沉到底了」。

## 2. 第一性原理分析

滚动治理 10 轮（8/13 弃 Virtuoso 起）共享同一结构性根因：**「枚举高度变化源并逐个补偿」是开放集合，永远枚举不完**。10/10 删 viewportObserver 是删一个补偿源，10/15 的跳动是另一个补偿源（clamp 损失补回）在起作用。

**根治方向**：不是继续枚举补偿源，而是让**输入框和消息列表视口解耦**——消息列表的 `clientHeight` 不随输入框变化，跳动机制链第一环（视口压缩）消失。

## 3. 方案设计

### 3.1 业界方案对比（10/15 研究）

| 方案 | 代表产品 | 思路 | 改动量 | 根治度 |
|------|----------|------|--------|--------|
| A. 覆盖层 | Slack/Discord/飞书 | 输入框 absolute 悬浮底部 | 小 | ⭐⭐⭐ |
| B. column-reverse | WhatsApp Web | flex 反向流 | 大 | ⭐⭐⭐ |
| C. scroll anchoring | Chrome 原生 | 重开浏览器锚定 | 极小 | ⭐⭐ 待验证 |
| D. 独立滚动区 | 微信/Telegram | 输入框区固定高度内部滚动 | 中 | ⭐⭐⭐ |

搭档拍板 D，实现中发现 D 的「固定高度」会浪费空间（输入框空着时底部空白），落地为 **A+D 混合**：输入框 absolute 悬浮（A 的脱离文档流）+ 内部自适应高度（D 的独立滚动）。

### 3.2 核心改动

**ChatView.tsx**：输入框区从 flex 兄弟改为 absolute 覆盖层
```tsx
// 旧：flex 兄弟，输入框撑高挤压消息列表
<MessageList />  {/* flex-1，被挤压 */}
<MessageInput /> {/* 高度变化挤压 */}

// 新：覆盖层，输入框悬浮底部不挤压
<MessageList style={{ paddingBottom: '170px' }} />  {/* 预留输入框空间 */}
<div className="absolute bottom-0 left-0 right-0 z-10">
  <MessageInput />  {/* absolute 悬浮，脱离文档流 */}
</div>
```

**MessageInput.tsx**：删 autoResize，textarea 用 CSS 自适应
```tsx
// 旧：autoResize() 每个按键写 style.height 撑高容器
el.style.height = 'auto'
el.style.height = `${Math.min(el.scrollHeight, 140)}px`

// 新：CSS field-sizing: content 自适应，max-h-[120px] 封顶
className="min-h-[24px] max-h-[120px] field-sizing-content"
```

**MessageList.tsx**：加 min-h-0 防 flex 溢出 + padding-bottom 预留输入框空间

### 3.3 为什么这是根治

| 机制链环节 | 旧方案 | 新方案 |
|-----------|--------|--------|
| 输入框撑高 | 挤压消息列表视口（clientHeight 减小） | 悬浮层不影响消息列表（clientHeight 恒定） |
| 视口压缩 | scrollTop 被动 clamp 下移 | 视口恒定，无 clamp 损失 |
| 封顶帧补回 | 累计 clamp 损失一次性补回（跳变） | 无损失可补，scrollTop 稳定 |

## 4. 影响范围

| 文件 | 改动 | 影响 |
|------|------|------|
| ChatView.tsx | 输入框区 absolute 覆盖层 | 布局结构变化，输入框悬浮底部 |
| MessageInput.tsx | 删 autoResize，CSS 自适应 | textarea 高度由 CSS 控制，max-h 120px |
| MessageList.tsx | min-h-0 + padding-bottom | 视口高度恒定，滚动逻辑零改动 |
| scroll-pin-frame-guard.spec.ts | 场景 C 补视口恒定断言 | e2e 回归锚 |

**不受影响**：scroll-pin 状态机、contentObserver、isNearBottom 判定——视口恒定后这些逻辑自然稳定。

## 5. 取舍

| 取舍 | 理由 |
|------|------|
| 输入框遮挡消息列表底部 | 消息列表 padding-bottom: 170px 预留，滚到底时最后一条消息在遮挡区上方。Slack/Discord 用户已习惯 |
| 输入框最大高度 120px（旧 140px） | textarea max-h 120px + 附件区/padding 40px = 总 160px，预留 170px 余量。120px 约 5 行中文，够日常输入 |
| field-sizing: content（Chrome 123+） | 2024 年 3 月可用，项目无 browserslist 声明，搭档环境 Chrome 最新。低版本浏览器回退为 min-h 24px 固定（不撑高但可用） |
| 删 autoResize | CSS 自适应已覆盖所有场景，JS 写 height 是冗余且是抖动源 |

## 6. 验证

| 验证 | 结果 |
|------|------|
| MessageList 单测 20/20 | ✅ |
| MessageInput 相关测试 11/11 | ✅ |
| 对话页全量测试 259/259 | ✅ |
| alpha 实例探针：纯输入 10 行 | 视口振幅 0px，scrollTop 漂移 0px ✅ |
| alpha 实例探针：输入框高度 | 24px → 120px 自适应 ✅ |
| e2e 场景 C 更新 | 补视口恒定断言（chVaries === 0）✅ |

## 7. 逃生口

若 field-sizing: content 在某些浏览器不生效（回退为 min-h 24px 固定高度），输入框不撑高但仍可输入（内部滚动）。观察使用反馈，若体验差再退回 JS autoResize（但保留覆盖层布局）。
