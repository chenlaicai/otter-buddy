---
name: writing-skills
description: >-
  Use when: 搭档要求新建或重写 skill（SKILL.md / manifest.yaml / frontmatter）.
  Not for: 使用已有 skill → 直接调用对应 skill. 修改 SYSTEM.md 全局规则 → 不在本 skill 范围.
  Output: 合规的 SKILL.md（三段式 description + category + 工作流）+ manifest 同步 + 通过 lint.
  能力摘要：创建或修改 otter skill 的元技能（含铁律、三段式契约、模板、lint 规则）。
co_loads: []
category: technique
---

# Writing Skills

写新 skill 或重写现有 skill 的元规范。这是关于 skill 的 skill。

## 触发

**触发条件**：
- 搭档要求新建一个 skill
- 搭档要求重写某 skill 的 description / 工作流
- lint 报错指向某 skill 违反铁律 / 三段式 / manifest 不一致

**排除**：
- 使用已有 skill 走对应 skill
- 改 SYSTEM.md 全局规则不在本 skill 范围（属 Part C / 系统层）

## 工作流

1. **明确意图**：新建 / 重写 / 修复 lint 错误？skill 名（kebab-case）、目标职责、触发场景、产出。一个 skill 只做一件事——合并后的 description 不能变"什么都能做"。

2. **选 category**：
   | category | 适用 | 例 |
   |---|---|---|
   | `technique` | 具体方法步骤，按工作流执行 | troubleshooting / code-implementation |
   | `pattern` | 思维模型原则，无固定步骤 | companion |
   | `reference` | 查表文档，给 LLM 在工作中查阅 | （未来如术语库 skill） |

3. **写 description（铁律 + 三段式）**：
   - **铁律**：description 只描述触发条件，绝不总结流程内容。
   - **例外 1（安全前置）**：可写 `Precondition: MUST ... BEFORE ...`，属触发约束。
   - **例外 2（能力摘要）**：可包含一句能力摘要，禁具体步骤。
   - **强制三段式**：`Use when: ... Not for: ... Output: ...`
   - **fallback skill 豁免**：companion 不强制三段式 marker。
   - **长度**：≤ 500 字符。超长说明职责过宽，拆 skill。

4. **套模板**：复制 `_shared/SKILL-TEMPLATE.md` 的"模板"段，填具体内容。保持五个段落：触发 / 输入 / 工作流 / 产出 / 参考。

5. **长度预算**：SKILL.md ≤ 200 行。超长内容移到 `references/`，主文件只留触发与工作流骨架。

6. **同步 manifest**：
   - frontmatter 是真相源（SDK 直接消费 name + description）
   - `prompts/skills/manifest.yaml` 由 `scripts/gen-manifest.mjs` 自动生成主体
   - 在 manifest 手写部分（`next / not_for / category / notes`）补充结构化字段——next 指向的 skill 必须存在，not_for 提到的 skill 必须存在

7. **跑 lint**：`npm run lint:skills`，0 error 才算完成。lint 规则见 `references/lint-rules.md`。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 合规 SKILL.md + manifest 同步 | 跑 lint 验证 | 当前獭 |
| lint 0 error | 搭档终审（如新建 skill） | 搭档 |

## 参考

- `_shared/SKILL-TEMPLATE.md` — 模板与铁律完整版
- `references/lint-rules.md` — lint 校验项与通过判据
- `references/skill-types.md` — technique / pattern / reference 三类的详细辨析
- `references/description-examples.md` — 合规与违规 description 示例对照
