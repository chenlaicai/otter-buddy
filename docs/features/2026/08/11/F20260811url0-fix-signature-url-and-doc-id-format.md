---
id: F20260811url0
title: fix-signature-url-and-doc-id-format
doc_type: feature
summary: |
  修复 PR 署名行中的仓库链接（orca-ai → chenlaicai）和 14 个 feature 文档的 ID 格式（后缀必须为 4 位字母数字）。
---

# F20260811url0: 修复PR署名链接和文档ID格式问题

## 背景

PR 署名行中的仓库链接指向错误地址（`orca-ai/otter-buddy`），应该指向实际仓库（`chenlaicai/otter-buddy`）。

同时，14 个 feature 文档的 ID 格式不符合规范（后缀不是固定的 4 位字母数字），导致 `lint:docs` 校验失败。

## 变更内容

1. **修复署名链接**（3处）
   - `.pi/skills/adversarial-review/SKILL.md` — 2 处
   - `.pi/skills/code-implementation/references/commit-convention.md` — 1 处

2. **修复文档 ID 格式**（14个）
   - 3 位后缀补齐：`cap` → `cap0`，`ctx` → `ctx0`，`hq1` → `hq10`，`dsp` → `dsp0`，`mmr` → `mmr0`
   - 5-6 位后缀截断：`speak` → `spea`，`tools` → `tool`，`guard` → `guar`，`chunk` → `chun`，`hybrid` → `hybr`，`aropt` → `arop`，`factlim` → `fact`，`rstart` → `rsta`

3. **F20260810cb01 补充**
   - 添加 frontmatter
   - 移至正确目录 `docs/features/2026/08/10/`

4. **F20260810rsta 修复**
   - capability_test 从指向不存在的文件改为 `n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为`

## 影响范围

- 14 个文件重命名（文件名中的旧 ID 更新为新 ID）
- 所有正文引用中的旧 ID 已更新
- F20260805hybrid 的 `doc_type` 字段已修正
- F20260811safen 的 ID 格式已修正（5位→4位）
- 不影响运行时行为，纯文档修复

## 验证

- [x] `npm run lint:docs` — 155 docs OK（7 warnings 不阻断）
- [x] `npm run lint:capability` — OK（62 warnings 存量过渡期）
- [x] `npm run build` — 通过
