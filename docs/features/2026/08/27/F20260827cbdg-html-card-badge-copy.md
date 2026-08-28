---
id: F20260827cbdg
title: HTML卡片徽标文案修正：沙箱隔离语义保留信任错位去除
doc_type: feature

# 记忆索引
summary: |
  HTML 卡片展开态底栏徽标文案优化：去掉「内容不可信」尾缀。原徽标「沙箱隔离 · 内容不可信」
  带浏览器 XSS 告警味，与产品信任模型（卡片内容均为海獭产出，隔离是渲染层技术措施而非
  内容不信任声明）不符。改为「沙箱渲染中」，同步更新回归测试断言（HtmlCard.test.tsx:58）。

# 因果链路
causal_links:
  from: []
  to: []

# 元数据
status: implemented   # 代码已实现（测试全绿），待对抗审视
change_type: prompt   # UI 文案属 prompt 层变更（用户可感知的措辞调整），无逻辑改动
capability_test: "web/src/pages/conversation/HtmlCard.test.tsx（徽标断言已同步新文案）"
tags: [html-card, web-ui, copywriting]
modules: [web/src]

# 时间
created_at: 2026-08-27
created_in_conversation: 60a89cc6-f61e-4e5c-a034-bb0570bf4735
---

# HTML 卡片徽标文案优化：去掉「内容不可信」

## 背景

搭档反馈：卡片展开时底栏徽标「沙箱隔离 · 内容不可信」读起来不对味——卡片内容都是海獭产出的，
「内容不可信」像是在告诉用户海獭不可靠。

## 分析

徽标的本意是技术层说明：HTML 卡片在 iframe sandbox（opaque origin，无 allow-same-origin）里渲染，
用户脚本无法访问宿主页面。这确实是「对不可信内容的标准隔离手段」，但把它翻译成用户可见文案就变了味：

- **信任模型错位**：本产品里卡片由海獭生成、海獭本身就是可信执行体，向用户展示「内容不可信」
  与「海獭是搭档的伙伴」的产品叙事冲突
- **信息价值错位**：用户需要知道的是「这块内容在隔离环境渲染」（所以打不开链接、表单受限），
  而不是「这块内容不可信」（用户并不需要为内容真实性操心）

## 改动

| 文件 | 改动 |
|------|------|
| `web/src/pages/conversation/HtmlCard.tsx:134` | 徽标文案 `沙箱隔离 · 内容不可信` → `沙箱渲染中` |
| `web/src/pages/conversation/HtmlCard.test.tsx:58` | 回归断言同步改为 `沙箱渲染中` |

## 验证

- HtmlCard.test.tsx 3/3（含 collapse→re-expand 回归）
- web 全量 vitest 236/236
- tsc --noEmit 0 错

## 取舍

- 保留「沙箱」词根：iframe sandbox 是真实的技术事实（脚本无法逃逸、链接点击受限），
  徽标继续向用户解释「为什么卡片里的行为和普通网页不一样」，只去掉与信任模型冲突的部分
- 备选「安全沙箱渲染」四字对称性更好，但「沙箱渲染中」更直白说明这是进行时状态而非能力声明，
  与 ShieldCheck 图标语义（防护中）一致
