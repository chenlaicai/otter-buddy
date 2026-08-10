---
name: adversarial-review
description: >-
  Find real problems in code changes (PR) or design documents.
  Not a rubber stamp. Covers multi-dimensional checking, independent verification,
  and structured problem reporting.
co_loads: []
---

# Adversarial Review

在审视对象中找到真实问题。不是橡皮图章。

## 触发

**触发条件**：搭档或父 agent 要求对代码变更（PR）或设计文档进行对抗审视时。

**排除**：自我审视（自己审自己等于没审）。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 审视对象（PR diff / 方案文档） | 是 | 停下来要求提供 |
| worktree 绝对路径（代码审视时） | 是 | 停下来要求提供 |
| 设计文档（代码审视时） | 否 | 跳过正确性对照，报告中声明"无设计文档对照" |

## 工作流

1. **理解变更范围**：读 PR 描述和变更文件列表。这个 PR 解决什么问题？设计意图是什么？哪些文件变了？爆炸半径多大？如果 PR 方向偏离设计文档，标记——可能需要退回设计阶段。

2. **声明本轮焦点**：检查任何内容之前，先声明 1-3 个焦点维度及理由。什么出错后果最严重？那就是焦点。焦点维度 → 深入读周边代码、追踪执行路径、验证声明。非焦点维度 → 快速扫过。无焦点的审视是散弹枪审视。

3. **逐维度检查**：6 个维度全部检查，焦点维度深入，其余快速扫过。无问题的维度也要显式写"无发现"。详见 `references/review-dimensions.md`。

   | 维度 | 核心问题 |
   |------|----------|
   | 正确性 | 实现是否符合设计意图？有无逻辑缺口？ |
   | 边界条件 | 空值、异常、并发、大数据——边界场景是否处理？ |
   | 安全性 | 注入、权限提升、敏感数据暴露？ |
   | 架构合规 | 是否遵守项目分层和约定？ |
   | 测试覆盖 | 核心行为是否测试？测试是否验证外部行为？ |
   | 可维护性 | 命名清晰？复杂逻辑有注释？有无不必要的重复？ |

   > **文档审视适配**：正确性→方案与需求一致？逻辑链完整？边界条件→失败路径被考虑？安全性→引入新攻击面？架构合规→符合项目约束？测试覆盖→含可验证的验收标准？可维护性→文档可读、决策有据？

   > **审视反模式提醒**：避免橡皮图章（走过场）、散弹枪（无焦点）、移动靶（标准漂移）等反模式。详见 `references/anti-patterns.md`。

4. **独立核实**：直接运行测试和构建，不只检查开发者的结果。

5. **输出报告**：按下方模板输出。每个判断必须引用具体 file:line，不接受“看起来没问题”。

6. **PR 留痕**（代码审视时）：审视报告输出到 otter 对话后，执行以下命令将结论 post 到 PR：

   ```bash
   gh pr review <PR_NUMBER> --comment --body "## 审查者
   [海獭名号]

   ## 审查结论
   [结论]

   ## 阻断性问题
   [问题清单，每条含 file:line]

   ## 次要观察
   [观察清单]

   🤖 Generated with [Otter Buddy](https://github.com/orca-ai/otter-buddy)"
   ```

   **注意**：
   - PR review comment 只放结论和问题清单，不放审视者自省、维度扫视等内部细节
   - 如果检视獭没有 `gh` 工具或 PR 信息缺失，跳过此步骤，在报告中声明“未留痕到 PR”
   - 文档审视不需要 PR 留痕

## 产出模板

```markdown
## 审查者
[海獭名号]

## 本轮焦点
- **焦点维度**：xxx
- **理由**：xxx

## 审查者自省
- 我是否把问题降级了？
- 我是否在替搭档做决定？
- 我是否用了淡化问题的话？

## 审查结论
**需要修改** / **存在以下问题（决策者判断）**

## 阻断性问题
### 问题 N：[简要描述]
- **维度**：xxx
- **位置**：`file:line`
- **描述**：xxx
- **处置**：在当前 PR 修复
- **建议修复**：xxx

## 次要观察
### 观察 N：[简要描述]
- **维度**：xxx
- **位置**：`file:line`
- **描述**：xxx
- **处置**：记录 / 在当前 PR 修复

## 维度扫视结论
| 维度 | 结论 |
|------|------|

## 变更完整性
- [ ] 验收标准 1
- [ ] 验收标准 2

🤖 Generated with [Otter Buddy](https://github.com/orca-ai/otter-buddy) by [海獭名号]
```

### 禁用语

审查者不能输出以下内容——这些是决策者的判断，不是审查者的：

- "可以合入"、"LGTM"、"Looks good"、"Looks fine"
- "Not blocking"、"Low risk"、"Can optimize later"

每个问题需要真实处置："在当前 PR 修复" 或 "记录（issue/PR 描述）"。"后续优化"不是处置——如果你说"记录为 issue"，你应该真的打算创建这个 issue。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 审视报告（otter 对话） | 作者按处置协议回应 | 实现者 |
| PR review comment | 外部可见的 review 记录 | 检视獭 |
| 审视通过 | 搭档终审 | 搭档 |

## 参考（索引）

- `references/review-dimensions.md` — 步骤 3 使用
- `references/anti-patterns.md` — 步骤 3 使用
- `references/review-loop.md` — 多轮审视收敛判据
- `references/author-response-protocol.md` — 作者处置协议
