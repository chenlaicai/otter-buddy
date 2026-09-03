---
name: post-merge-cleanup
description: >-
  Use when: 搭档说"已合入"/"合了"/"merged"/"收拾一下"/"善后"等收尾指令，或要求清理堆积的分支/worktree.
  Not for: 功能开发 → code-implementation. PR 审视 → adversarial-review. 闲聊讨论 → companion.
  Output: 结构化清理报告（逐项列出 worktree / 分支 / issue / 产物的清理状态，部分失败标注原因）。
co_loads: []
category: technique
---

# PR 合入后收尾清理

PR 合入后的资源回收：worktree、本地分支、远程分支、源头 issue、产物状态、检视獭。支持单 PR 清理和批量扫尾。

## 触发

**触发条件**：
- 搭档说"已合入"/"合了"/"merged"/"收拾一下"/"善后"
- 搭档说"清理 XXX 分支"（特定分支清理）
- 搭档说"清理一下过期分支"（批量扫尾模式）

**排除**：功能开发 → `code-implementation`。PR 审视 → `adversarial-review`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| PR 编号或分支名 | 否 | 从对话上下文推断；推断不出则问搭档 |

## 工作流

### 单 PR 清理

1. **定位 PR**：从对话上下文找 PR 编号。找不到则问搭档。若搭档给了分支名，用 `gh pr list --head <branch>` 找对应 PR。

2. **验证合入状态**：`gh pr view <PR> --json state,mergedAt,headRefName`
   - `MERGED` → 继续
   - `OPEN` → 报告搭档"这个 PR 好像还没合入"，终止
   - `CLOSED`（未合入）→ 报告搭档，终止

3. **清理 worktree**：
   - 从 `git worktree list` 找与该分支关联的 worktree 路径
   - 检测 lock 文件：`ls .git/worktrees/<name>/locked`，存在则删除
   - 检测 dirty state：`git -C <worktree-path> status --porcelain`
     - 有未提交变更 → **不自动删除**，报告搭档决策
     - 干净 → `git worktree remove <path>`（失败重试一次，仍失败记录跳过）
   - 清理元数据残留：检查 `.git/worktrees/<name>/` 是否还存在，存在则 `rm -rf`

4. **删除本地分支**：
   - **保护分支检查**：若分支名为 `main` / `develop` / `production`（或仓库定义的保护分支），**跳过**，不删除
   - `git branch --list <branch>` 检查存在性
   - 存在 → `git branch -D <branch>`（-D 强制删除，因 PR 已合入）
   - 不存在 → 跳过

5. **删除远程分支**：
   - `git ls-remote --heads origin <branch>` 检查远程是否存在
   - 存在 → `git push origin --delete <branch>`（失败记录，不阻塞）
   - 不存在 → 跳过

6. **关闭源头 issue**：
   - `gh pr view <PR> --json body` 取 PR description
   - 用正则提取 `Fixes #N` / `Closes #N` / `Resolves #N`（含小写变体）模式
     - 匹配到 → `gh issue view <N> --json state` 检查状态
       - OPEN → `gh issue close <N>` + 注释关联 PR
       - CLOSED → 跳过
     - 匹配到 `Related to #N` → 只在 issue 加评论，不关闭
     - 无匹配 → 跳过（不问搭档，不阻塞）

7. **更新产物状态**：
   - `list_artifacts` 按 groupId 过滤相关资源
   - worktree 类型 → archived
   - PR 类型 → archived
   - 已 archived → 跳过

8. **工作区文件清理**：
   - 用 `workspace_list` 列出本对话工作区文件清单（含子目录递归），按文件大小降序排列
   - 分类判定：
     - **建议删除**：截图（*.png/*.jpg/*.jpeg）、临时脚本、中间生成物、调试输出
     - **默认保留并提示搭档**：研究报告、方案文档、持久化配置等有长期价值的文件
   - 将建议删除清单呈搭档确认后执行 `workspace_read` 校验 + 删除（删除不可逆，宁可多确认不激进自动删）
   - 若工作区为空或无临时文件，跳过本步

9. **关键资源状态流转**：
   - `list_artifacts` 按当前对话过滤所有资源
   - PR 已合入且资源类型为 pr/worktree/branch、状态仍 active 的 → `update_artifact_status` 流转至 archived
   - fact/file/url 类型资源默认保留（记录型资源有长期追溯价值）
   - 已 archived/superseded → 跳过
   - 流转结果记入清理报告

10. **解散检视獭**：
   - `get_active_participants` 查在场成员
   - 名字含"检视"/"delta"/"review" 且非当前獭/搭档 → `dissolve_otter`
   - 最后执行，确认清理完成再解散

11. **汇报**：用结构化格式向搭档报告（见产出）。

### 批量扫尾模式

搭档说"清理一下过期分支/堆积"时触发：

1. **扫描**：`git worktree list --porcelain` + `git branch --list 'feature/*' 'fix/*' 'refactor/*' 'chore/*' 'feat/*' 'hotfix/*'`
2. **关联 PR 状态**：对每个本地分支查 `gh pr list --head <branch> --state all --json number,state,mergedAt`
3. **分类**：
   - PR 已合入 → 可清理
   - PR 已关闭（未合入）→ 可清理
   - PR 仍 OPEN → 保留
   - 无关联 PR → **零 commit ≠ 废弃（F20260901cimp）**：空/无 commit 的 worktree 唯一合法结论是「可能正在开工」，禁止直接判残留。删前必核两证：① 目录 mtime >48h 无更新；② 无活跃 otter-claim 认领（在 issue 评论 otter-claim 注释中精确匹配 `worktree=<worktree名>` 字段，禁止模糊搜短名，认领协议见 worktree-isolation 步骤 2）。两证皆成立才列废弃候选；任一不成立 → 保留并在报告中标注「疑似在途」（#665/#679 撞车的镜像风险：清理线误删刚开工的现场与撞车同源）
4. **呈现清单**：列出待清理项（worktree 路径 + 分支名 + PR 状态），等搭档确认
5. **执行清理**：确认后逐项执行上述单 PR 清理流程

## 产出

### 单 PR 清理报告

```
✅ PR #<N> 合入后清理完成
- worktree: <name> ✅
- 本地分支: <branch> ✅
- 远程分支: <branch> ✅
- 源头 issue: #<N>（已关闭）
- 产物状态: <N> 个资源 → archived
- 工作区清理: <N> 个临时文件已删除（<大小>）/ 无临时文件，跳过
- 关键资源流转: <N> 个 pr/worktree/branch 资源 → archived
```

部分失败时：

```
⚠️ PR #<N> 合入后清理（部分完成）
- worktree: <name> ✅
- 本地分支: <branch> ✅
- 远程分支: <branch> ❌（权限不足，需手动删除）
- 源头 issue：未找到关联编号，跳过
- 工作区清理: 搭档未确认删除建议，跳过
- 关键资源流转: <N> 个资源 → archived
```

### 批量扫尾报告

呈现待清理清单，等搭档确认后执行。执行后逐项报告结果。

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 清理完成 | 无 | 当前獭 |
| worktree 有未提交变更 | 搭档决策 | 搭档 |
| 工作区清理建议清单 | 搭档确认后执行删除 | 搭档 |
| 关键资源状态流转结果 | 无（已自动执行） | 当前獭 |
| 批量扫尾清单 | 搭档确认后执行 | 搭档 |

## 参考（索引）

- worktree-isolation skill — worktree 创建阶段，本 skill 是其生命周期的收尾（上下文说明，无需读其 SKILL.md）
- code-implementation skill — PR 创建阶段，本 skill 是其产出的后续（上下文说明，无需读其 SKILL.md）
