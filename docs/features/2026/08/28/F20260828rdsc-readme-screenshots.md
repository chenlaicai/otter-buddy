---
id: F20260828rdsc
title: README 首屏增加系统运行截图
summary: README 首屏增加主对话界面截图。求职场景下招聘方 10 秒内打开 README，第一屏看到系统真实运行画面是「项目是活的」最强信号；纯文字+ASCII 架构图缺少这一层直观性。截图经 playwright 2x 采集、降采样至 1600px、JPEG q92 压缩至 404KB，落位 docs/images/。
change_type: feature
status: implemented
capability_test: "n/a: 纯文档改动（A 类），无 LLM 参与行为"
created_in_conversation: 09bf83a5-8a9a-4aba-815e-a92c783b4800
---

# README 系统截图

## 背景

搭档求职中，README 是简历的延伸展示面（简历已链接 https://github.com/chenlaicai/otter-buddy）。招聘方打开 README 的前 10 秒决定第一印象——当前 README 全部为文字 + ASCII 架构图，缺少「系统真实在跑」的直观信号。

搭档于 2026-08-28 会话决策：

1. 采用对话页截图（记忆页/技能页内容为空，不用）
2. 截图内容透露问题不大（对话内容已由搭档亲自过目）

## 改动

| 文件 | 改动 |
|------|------|
| `docs/images/conversation.jpg` | 新增，1600×1000 JPEG q92，404KB |
| `README.md` | 顶部简介下方插入截图 + 一句说明 |
| `README.en.md` | 同步英文版 |

截图插入位置：标题下、设计哲学之前——打开 README 第一屏即见。

## 截图规格决策

- **采集**：playwright chromium headless，deviceScaleFactor=2（retina），viewport 1600×1000 → 原图 3200×2000
- **降采样**：sips -Z 1600 → 1600×1000，README 展示宽度下清晰度足够
- **格式 JPEG q92**：文字为主的界面截图 PNG 1.6MB vs JPEG q92 404KB（体积降 75%）；q92 在文字边缘涂抹可接受范围（已目验）。GitHub README 图无懒加载，首屏 404KB 可接受
- **弃用 PNG**：无 pngquant 可用，未压缩 PNG 体积不可接受；WebP 转换失败（sips 退出码 13）环境不支持

## 敏感性检查

截图内容由搭档亲自过目确认可公开（对话记录无隐私泄露风险）。执行獭二次目验：无 API key、无数据库连接串、无密码类硬敏感信息。环境依赖表格未入镜。

## 验证

```bash
cd .claude/worktrees/readme-screenshots
git diff origin/main --stat   # 3 files changed
# README.md / README.en.md 各 +4 行，docs/images/conversation.jpg 新增
```

渲染验证：相对路径 `docs/images/conversation.jpg`，GitHub 渲染时基于文件路径解析，与仓库内引用方式一致。

## 后续（不在本 PR 范围）

- 记忆页/技能页内容补实后可增补对应截图（搭档已知晓两页当前为空）
