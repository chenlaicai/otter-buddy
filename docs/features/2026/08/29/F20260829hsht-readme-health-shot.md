---
id: F20260829hsht
title: README 补健康面板截图
summary: PR #557 合入后的 Step 3 收尾：健康面板四图看板（趋势双轴/类型环形/模块热区/五态堆叠条）以真实数据截图补入 README 首屏，与对话截图形成"协作现场 + 自我度量"两张图呼应，中英双版同步。
change_type: feature-update
status: active
created_in_conversation: 09bf83a5-8a9a-4aba-815e-a92c783b4800
capability_test: n/a（纯文档+图片，无逻辑变更；图片内容经敏感词预扫 + 目验）
from:
  - F20260829hviz
tags: [readme, screenshot, health-dashboard, docs]
modules:
  - README.md
  - README.en.md
  - docs/images/health-dashboard.jpg
---

# README 补健康面板截图

## 背景

F20260829hviz（PR #557）交付健康面板四图看板后，与搭档约定的 Step 3：等面板有真实数据再截图补进 README——"面板页数据真实有图表了再截图，比现在拍更好"。

## 改动

- `docs/images/health-dashboard.jpg`（新增，1600×1000 JPEG，164KB）：健康面板总览视图截图，含四图看板全貌
- `README.md` / `README.en.md`：对话截图下方追加健康面板图 + 一句说明（两张图都是真实数据：协作现场 + 系统自我度量）

## 截图方式与数据真实性

- 图表数据来自真实库 `data/otter-buddy.db`：30 天快照序列（`health_snapshots` 331 行）、开放信号（122）、特性链五态（329 链 = 275 active / 50 stalled / 4 orphan，由 chain-builder 真实构建）
- 截图链路：主仓构建 web/dist（含 recharts）→ 最小静态服务器（端口 3210，服务真实 dist + 真实库数据 API）→ Playwright 1600×1000 @2x → sips 压缩为 1600px JPEG
- 敏感性：截前 Playwright 页面文本预扫（appSecret/token/Bearer/apiKey/password 零命中）+ 截后目验（无密钥/无隐私/无内部路径泄露）

## 验证

- [x] 图片渲染：8 个 recharts svg 全部渲染（趋势双轴/环形/热区/五态条）
- [x] 数据真实：109 commits（60 天窗口）、BugFix 比率 26.6%、模块热区 TOP8、五态分布
- [x] 敏感扫描：预扫 + 目验双轮干净
- [x] 中英双版插入位置对称（对话截图正下方）
- [x] lint-docs 通过
