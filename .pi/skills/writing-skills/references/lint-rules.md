# lint-rules.md

`scripts/lint-skills.mjs` 的校验项（F20260811sktp）。共 11 项（7 error + 4 warning），按严重程度分 error（阻断）和 warning（不阻断）。

## error（阻断）

| # | 校验项 | 失败示例 |
|---|---|---|
| 1 | 每个 `.pi/skills/<name>/SKILL.md` 必有 frontmatter：`name / description / co_loads / category` | 缺 category 字段 |
| 2 | frontmatter.name 必须等于目录名 | 目录 `troubleshooting/` 但 name 是 `trouble-shooting` |
| 3 | manifest skill 集合与 `.pi/skills/` 目录集合双向一致（防孤立） | manifest 有 `xxx` 但 `.pi/skills/xxx/` 不存在，或反之 |
| 4 | manifest 中 `next` 指向的 skill 必须存在 | next: [non-existent] |
| 5 | manifest 中 `not_for` 提到的 skill 必须存在 | not_for 写了不存在的 skill 名 |
| 6 | manifest category 与 SKILL.md frontmatter category 一致（防漂移） | manifest=technique 但 frontmatter=pattern |
| 7 | `references/` 中提到的文件路径必须存在 | SKILL.md 写 `references/xxx.md` 但文件不存在 |

## warning（不阻断）

| # | 校验项 | 说明 |
|---|---|---|
| W1 | SKILL.md 行数 ≤ 200 | 超长提示移到 references/，不阻断 |
| W2 | description 长度 ≤ 500 字符 | 超长提示职责可能过宽，不阻断 |
| W3 | 两个 skill 的 not_for 互指对方 | 提示检查 Use when 是否有足够区分度 |
| W4 | description 不含三段式 marker（Use when / Not for / Output） | 提示（companion 豁免），不阻断 |

## 不校验的项（已删，F20260811sktp A-R4）

| 删除项 | 删除理由 |
|---|---|
| ~~description 必须含三段式 marker（error）~~ | 无法做语义判断，降为 warning |
| ~~description 长度 30-500（error）~~ | 下限不合理，clowder-ai 也无字符约束 |
| ~~manifest 与 frontmatter description 等价（error）~~ | D7 砍掉：manifest 不写 description 镜像，lint 不校验 description 等价 |

## 通过判据

`npm run lint:skills` 输出 0 error 即通过。warning 记录但不阻断 commit。
