---
id: F20260921sgid
intent:
  problem: "F20260914sgln 修法（模板+真相源收敛）合入后大獭 PR 署名仍漂移：#921 合入后 9/18-9/21 的 19 个 PR 漂移 11 个（58%）。根因是 CLI 建 PR（gh pr create --body-file）不加载 .github 模板，且 v2 指针化删光了动作锚点旁的格式实体——输出时刻格式不在场，靠「记得去查」的纪律路径已证伪（反证：检视獭输出模板末尾就地有格式要求，规范率 ~86%；身份段名号每轮注入，19/19 零失误）"
  expected_effect: "署名行成品与 commit author 格式随身份段每轮注入（identity-builder.ts 管道），大獭小獭通吃；PR body 署名规范率从 58% 回升至身份注入历史水平（~100% 名号正确 + 格式照抄在场）；「author 格式串场进 body」「占位符填空」两类混淆因三格式同段在场而消失"
  verify_by:
    type: behavior_check
created_in_conversation: 5777dadb-93fb-4a1a-b6ad-47e6a89dcbdd
title: 签名机制重设计：格式升格为身份，署名行成品随身份段注入
summary: "签名 = 身份 × 格式 × 时机。身份（名号）经 identity-builder 管道 19/19 零失误，格式靠纪律 58% 漂移——把格式挂上已验证的身份管道，署名从「执行规范」降为「复制眼前一行」。快照从 1 对（.github 模板）变 2 对（+identity-builder 管道快照），同步义务成文于 signature-convention skill。"
change_type: feature
capability_test: "n/a: 身份段注入行为由单元测试锁死（tests/frameworks/agent/identity-prefix.test.ts F20260921sgid 用例），真实署名行为属 behavior_check（后续 PR 观察规范率）"
tags: [signature, identity, prompt-injection, convention]
modules:
  - src/frameworks/agent/identity-builder.ts
  - prompts/identity/BIG_OTTER.md
  - .pi/skills/signature-convention/SKILL.md
  - .pi/skills/code-implementation/SKILL.md
  - tests/frameworks/agent/identity-prefix.test.ts
causal_links:
  from: [F20260914sgln]
created_at: 2026-09-21T12:50:00+08:00
---

# 签名机制重设计：格式升格为身份

## 问题现场

搭档 9/21 目击：F20260914sgln（PR #921，9/15 合入）修法后大獭 PR 署名仍然乱。复核取证（#921 合入后的 9/18-9/21，19 个 PR）：

| 署名形态 | PR | 计数 |
|---|---|---|
| 规范 `🤖 Generated with Otter Buddy by 名号` | #1080 #1078 #1071 #1066 #1064 #1050 #1049* #1065* | 8 |
| `🦦 大獭` 等即兴变体 | #1053 #1055 #1070 #1073 #1075 #1082 | 6 |
| commit author 格式串场（`大獭 <otter-buddy>`） | #1072 #1076 #1057 | 3 |
| 占位符半替换 `[大獭]` | #1046 | 1 |
| Co-authored-by 尾注 | #1047 | 1 |

*#1049/#1065 为小獭所建（开发獭-交接GLM / 移除獭，fresh session 先 read 真相源侥幸对齐）。

**漂移率 58%（11/19）**；同期 review 评论规范率约 86%（检视链路）；名号正确率 19/19 = 100%。

## 根因（相对 F20260914sgln 的增量）

1. **CLI 路径三重落空**：大獭走 `gh pr create --body-file`——.github 模板不注入（GitHub 文档证实 + #921 文档已记录）；v2 指针化删光了 commit-convention.md 里最后一个格式实体；code-implementation 步骤 9（建 PR 动作锚点）零署名提醒（提醒在步骤 8，管 commit）。
2. **统一解释变量——在场性**：四条链路按「输出时刻格式是否在场」排序，规范率单调对应：身份段注入（名号）100% > 检视输出模板末尾（~86%）> skill 完整命令（commit author）稳定 > skill 参考文档按需 read（PR body）58%。**当场可抄就稳，需要回忆就漂。**
3. **签名是两个东西**：身份（谁在签）是事实，每轮注入从未漂移；格式（长什么样）是规范，需要「记得存在 + 记得去查 + 正确执行」三步纪律。漂移的全是格式，不是身份。

## 方案（搭档拍板）

**把格式升格为身份的一部分——署名行成品随身份段每轮注入。**

设计哲学（搭档原话）：「签名是锦上添花，校验反而带来更大的负担，关注点肯定是事前如何做对」——不做事后校验，让做对不需要纪律。

身份段升级（identity-builder.ts 头部）：

```
## 你的身份
- 名称：大獭
- 名号：大獭
- 你的署名行（PR description / review 评论末尾，原样复制下面这行，不要凭记忆改写格式）：
  🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
- commit author（git commit --author 参数值，整体照抄）：大獭 <otter-buddy>
- ID：…
```

- 复用已被验证的管道：身份注入 19/19 零失误，格式挂上去等于把 58% 链路接进 100% 管道
- 认知负荷从「执行规范」降为「复制一行」——抄自己名字从来没错过
- 大獭小獭通吃：identity-builder 是所有 otter 公共路径，小獭自动带召唤名
- 三处格式同段在场：「author 格式串场进 body」「占位符填空」两类混淆结构上消失

**否决的备选**：gh 命令包装自动 append——机器附加失去「獭主动署名」语义（签名是责任主体的自我声明，不是系统盖章），跨环境覆盖不了，为锦上添花建基础设施正是搭档反对的负担。事后校验（搭档明确否决）。

## 设计取舍

**机制识别检查点判定**（动手前完成，清单逐项）：新增配置字段 ✗ / 新增状态生命周期 ✗ / 新增定时任务 ✗ / 新增信号类型 ✗ / 新增持久化 ✗ / 新增决策分支（结果被记住并影响后续行为）✗ / 新增跨模块调用路径 ✗——**全部未命中**。身份注入管道与身份段子块结构均为既有机制，本次是其内容语义内扩展（身份段多两个字段）→ 修法排序①，`Modification-Class: narrow-fix`。

**最简实现检查**：已过阶梯——仓库既有 identity-builder 管道（复用，非新建）；不新增依赖；改动 = identity-builder.ts 一处模板串 + BIG_OTTER.md 名号节改指针 + skill 消费关系重排 + 测试一例。无更简实现可达同等效果（.github 模板路径对 CLI 无效已被 #921 证伪）。

**快照从 1 对变 2 对的代价**：identity-builder.ts 代码里出现格式实体（管道快照，性质同 .github 平台快照，机制上无法指针化——运行时不加载 skill 文件）。同步义务成文于 signature-convention skill「快照同步义务」节。漂移面从「每次输出」降到「格式变更时」；若未来改格式忘同步，注入的是一致地旧，不再百花齐放。

## 变更清单

| 文件 | 变更 |
|---|---|
| `src/frameworks/agent/identity-builder.ts` | 身份段头部追加署名行成品 + commit author 格式（名号动态填充），含 F20260921sgid 注释说明快照性质 |
| `prompts/identity/BIG_OTTER.md` | 「你的名号」节删除 [海獭名号] 替换规则实体，改为指向身份段注入（消除与管道快照的双源） |
| `.pi/skills/signature-convention/SKILL.md` | 「平台快照同步义务」扩为「快照同步义务（两处）」；指针使用方清单 +BIG_OTTER.md；新增运行时注入关系说明 |
| `.pi/skills/code-implementation/SKILL.md` | 步骤 9 追加半句「body 尾部带署名行（照抄身份段）」——防呆提醒非依赖 |
| `tests/frameworks/agent/identity-prefix.test.ts` | 新增 F20260921sgid 用例：大獭/小獭署名行与 author 格式注入断言（名号动态） |

## 验证

- [x] `npx vitest run tests/frameworks/agent/` 33 files / 523 tests 全绿（含新增用例）
- [x] `npm run build` 通过；`npm run lint:intent` 通过
- [x] 同日两次构建逐字节一致（F20260829cach 前缀缓存不变量未破坏——身份段在日粒度日期锚点之前，但段内容日内恒定）
- [x] 最简实现检查：已过（见设计取舍）
- [x] bugfix 失败证据链：n/a——本特性为 prompt 注入机制扩展，非 bug 修复（漂移现象的「失败用例」是 LLM 行为漂移，由 behavior_check 后续观察，无可固化单测）
- [ ] behavior_check：后续 PR 署名规范率回升（本 PR 自身即第一个样本——按新机制，本 PR body 应含照抄的署名行）
- Golden Gate：n/a 说明——本 PR 含 prompt 改动，golden gate 已跑（见 PR Verification 节记录）

## 对旧特性做了什么

- F20260914sgln：其「平台快照唯一双源」表述被本特性扩为两处快照；其修法（模板 + 指针化）不回滚，继续生效——本特性补的是它没覆盖的 CLI 运行时路径。历史文档未改动（铁律），关系见 frontmatter `causal_links.from`。
