---
id: F20260914sgln
title: PR 模板补署名行：GitHub 自动加载治本署名漂移
summary: "大獭近 10 个 PR 署名行写法漂移出 6 种花样（含把占位符 [海獭名号] 当字段填空），根因是权威模板 .github/pull_request_template.md 从未有署名行、署名规范只藏在 skill 参考文档里。治本修法：模板尾部直接加署名行占位符 + 防呆注释，创建 PR 时 GitHub 自动加载。"
change_type: fix
capability_test: "n/a: 纯模板文档追加，无可执行逻辑；验证靠模板渲染检查（GitHub 新建 PR 页自动加载该模板即生效）"
created_in_conversation: 17845047-58bc-409e-a0a9-25ac8feb9c04
tags: [signature, pr-template, github, convention]
modules: [.github/pull_request_template.md]
created_at: 2026-09-14T20:44:00+08:00
---

# PR 模板补署名行

## 问题现场

搭档在 GitHub 上看到大獭 PR 的署名是 `[海獭名号: 大獭]` 这种怪格式，而检视獭们的签名是规范的 `🤖 Generated with [Otter Buddy](...) by 检视獭-xxx`，质疑为何突然漂移。

取证（2026-09-14，最近 10 个 PR 的署名行）：

| PR | 署名行实写 |
|---|---|
| #909 | `[大獭]` |
| #912 | `作者: 大獭` |
| #918 | `🦦 Authored by 大獭` |
| #903 | `🦦 by 大獭` |
| #915 / #919 | `🦦 生成：大獭（GLM-5.3）` |
| #910 / #914 | `🦦 大獭（GLM）` |
| #916 | `🦦 大獭` |
| #917 | `🦦 大獭 (glm)` |

6 种写法并存。`[海獭名号: 大獭]`（搭档目击）与 `[大獭]`（#909）同源——把规范占位符 `[海獭名号]` 理解成了"字段名: 值"的填空题。

## 根因

两层：

1. **结构缺口（主因）**：权威模板 `.github/pull_request_template.md` 三个历史版本（8/24 #375、8/29 #577、9/2 #712）均无署名行；署名格式只存在于 skill 参考文档（`code-implementation/references/commit-convention.md`）。检视獭走 adversarial-review，产出模板硬编码整行照抄不乱；大獭创建 PR 靠 GitHub 自动加载模板，模板里没有，署名全凭"记得去查文档"的自觉——结构上就留了漂移口。
2. **触发因素（次因，置信度中高）**：大獭 2026-09-14 切换模型（kimi 周配额 403 → glm），新模型对藏在参考文档里的规范遵循度下降；乱象集中出现在 9-14 的 #903 之后，时间线吻合。

## 修法

修法排序② 之外的**结构性收口**——把规范从"参考文档自觉遵循"上移到"权威模板自动加载"：

`.github/pull_request_template.md` 尾部追加：

```markdown
---

<!-- 署名行（创建时必填）：将下方 [海獭名号] 占位符整体替换为实际署名獭的名号（如「大獭」「检视獭-903fin」），禁止保留占位符原样或改写成「[海獭名号: xxx]」字段填空格式。未署名的 PR 不得创建。 -->

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by [海獭名号]
```

防呆注释点名禁止 `[海獭名号: xxx]` 填空格式——这正是本次搭档目击的漂移形态。

## 架构升级 v2：单一真相源指针化（搭档决策，PR #921 第二轮追加）

初版合入前搭档两次追问：①「检视獭 skill 里的为什么不删？没全局统一？」②拍板「外部留痕签名单独做一个 skill，其余指针指向它」。

**决策**：署名格式唯一真相源收敛到 `signature-convention/SKILL.md`，其余文件实体全部改指针：

| 文件 | 改造 |
|---|---|
| signature-convention/SKILL.md | 升格为唯一真相源：定义 commit author / PR description / review 评论三处格式 + 「平台快照同步义务」节 + 「指针使用方清单」节 |
| adversarial-review/SKILL.md | 3 处签名行实体 → 指针（身份占位符 [海獭名号]「审查者是谁」保留，非签名格式） |
| code-implementation/references/commit-convention.md | PR Description 模板尾签名行实体 → 指针 |
| .github/pull_request_template.md | 保留实体，性质降格为「平台快照」（GitHub 网页创建 PR 自动预填依赖，机制上无法指针化；同步义务成文） |

**架构依据**：物理双源（真相源 + 平台快照）只剩 1 对且同步义务成文；其余 4 处实体→指针，格式漂移面从 5 处降到 1 处。比备选方案「快照清单 + 修改须同步全部」（靠纪律，仍 5 处实体）结构更稳。

**补充事实修正**：`gh pr create --body-file` 不自动附加 PR 模板（CLI 完全替换 body）——对獭而言 .github 模板是权威参照物而非自动注入；真相源中已明文提示。

## 非目标

- 不回改历史 PR 的署名行（历史留痕也有价值；且旧 PR 已合入，改动无收益）
- 不动 commit author 签名（`git commit --author` 一直正常，squash merge 后统一归 chen_n，无漂移）
- 不动 review 评论署名（adversarial-review 模板硬编码，无漂移）

## 验证

- [x] 模板尾部署名行与 skill 参考文档格式逐字一致（`🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by [海獭名号]`）
- [x] v2 指针化后全仓扫描：`Generated with [Otter Buddy]` 实体仅存 signature-convention/SKILL.md（真相源）与 .github/pull_request_template.md（平台快照），其余活文件零残留
- [x] `npm run lint:skills` 0 error
- [ ] 合入后新建 PR 页面自动加载含署名行的模板（搭档下次创建 PR 时自然验证）
