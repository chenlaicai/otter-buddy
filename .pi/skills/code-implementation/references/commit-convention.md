# Commit Convention

## Message Format

```
[FYYYYMMDDxxxx][module][type] 描述
```

- `FYYYYMMDDxxxx`: Feature number (immutable once assigned)。生成新 ID 前必须查重：`grep -rl '<title 或主题关键词>' docs/features/ docs/research/`，存在同 title/语义相同文档则复用其 ID——跨 worktree 自编新 ID 会致旧 ID chunk 残留 memory 库；标题搜不到时改用主题关键词重试，仍无命中才可自编
- `module`: Affected module name (e.g., `skills`, `agent-runtime`, `conversation`)
- `type`: One of `New Feature`, `Feature Update`, `BugFix`, `Refactor`, `Design`（与 Type Tags 表及 .githooks/commit-msg 白名单一致；`Feature` 为 `New Feature` 的历史别名，2026-08-25 起不再收录，存量提交见 git 历史）
- `描述`: Chinese description of the change

## Modification-Class Declaration

Commit message body 必须含一行修改类别声明（与 troubleshooting 修法排序对应）：

```
Modification-Class: narrow-fix | scope-reduction | deletion | mechanism-addition | docs-config
```

- `narrow-fix`：修法排序① 既有机制语义内修（缺啥补啥）。⚠️ 若机制识别检查点（清单见 troubleshooting 修法排序节）命中任一项却仍判①②③，特性文档必须含一句「为何命中但不涉净新增机制」的论证——论证不出说明实际走④，声明值与文档都要改
- `scope-reduction`：修法排序② 收窄问题机制的管辖边界
- `deletion`：修法排序③ 删除机制
- `mechanism-addition`：修法排序④ 新增机制（须经重对抗门通过）。**声明此类 = 承诺本分支特性文档「设计取舍」段已含机制识别检查点判定 + 机制预算四问答案**——检查点清单与四问定义见 troubleshooting skill 修法排序节 / requirement-analysis skill 步骤 5-6；issue 驱动未经方案流程直接实现的特性同样适用，提交前发现没判过 → 先在特性文档补判定（命中则四问当场作答），再提交
- `docs-config`：纯文档/配置微调，不经修法排序

声明进 git 记录，每日全局回看验证声明与实际 diff 一致性——声明非 `mechanism-addition` 但 diff 实增机制 = 高严重度补丁证据。P0 紧急修复可先修后补审：声明值后标注 `(P0-emergency, post-review pending)`。

## Type Tags

| Tag | When to Use |
|-----|-------------|
| `New Feature` | Wholly new functionality |
| `Feature Update` | Enhancement to existing feature |
| `BugFix` | Bug fix |
| `Refactor` | Code restructuring without behavior change |
| `Design` | Documentation/design-only changes |

## Incompatible Changes

If the change breaks existing behavior, add `[Incompatible]` before the description:

```
[F<日期><id>][module][Feature Update][Incompatible] 描述
```

## PR Title

Same format as commit message. PR number is appended by GitHub automatically.

## PR Flow

### Mandatory Rules

1. **PR-only delivery**: All code changes must be delivered via PR, never direct push
2. **No direct push to protected branches**: `main`, `develop`, `production` are protected
3. **Separation of duties**: Developer cannot merge their own PR
4. **PR description 署名**：PR description 末尾署名行必须填写实际海獭名号（格式真相源：signature-convention skill），未署名的 PR 不得创建（完整署名约定见 signature-convention skill）

### PR Workflow

```
1. Create worktree branch
2. Make changes and commit
3. Push branch: git push -u origin <branch>
4. Create PR: gh pr create
5. 召唤检视獭对抗审视（流程见 SKILL.md step 8）
6. 审视通过 → 搭档终审并合入
7. Clean up worktree
```

### Forbidden Actions

- `git push origin main` — direct push to main
- `git push origin develop` — direct push to develop
- Merge your own PR — violates separation of duties
- Skip worktree for "small" changes — all changes need isolation

### PR Description Template

> 以 `.github/pull_request_template.md` 为权威模板（GitHub 自动加载），此处仅为格式参考。两版结构差异：`.github` 版面向创建者（含 Why / Risks / Verification 等填空），此处版面面向检视者（突出 Discovered Issues 的 issue 链接要求）。**末尾署名行格式不在本文件定义——唯一真相源见 signature-convention skill 的 PR description 署名行（`.github` 模板中同款行为其平台快照）。**

```markdown
## Summary
- What changed and why

## Changes
- File-by-file description

## Opportunistic Fixes
- List any issues found and fixed outside plan scope (same module/file/function)
- If none, write "无"

## Discovered Issues
- Issues found but not fixed in this PR. Each must include a GitHub issue link (`#NNN`) — created via `gh issue create`
- 口头"已记录"不合规——必须有 issue 链接
- If none, write "无"

## Test plan
- [ ] Verification steps

（末尾附 signature-convention skill 的 PR description 署名行）
```
