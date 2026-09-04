# Commit Convention

## Message Format

```
[FYYYYMMDDxxxx][module][type] 描述
```

- `FYYYYMMDDxxxx`: Feature number (immutable once assigned)。生成新 ID 前必须查重：`grep -rl '<title 或主题关键词>' docs/features/ docs/research/`，存在同 title/语义相同文档则复用其 ID——跨 worktree 自编新 ID 会致旧 ID chunk 残留 memory 库（#524）；标题搜不到时改用主题关键词重试，仍无命中才可自编
- `module`: Affected module name (e.g., `skills`, `agent-runtime`, `conversation`)
- `type`: One of `New Feature`, `Feature Update`, `BugFix`, `Refactor`, `Design`（与 Type Tags 表及 .githooks/commit-msg 白名单一致；`Feature` 为 `New Feature` 的历史别名，2026-08-25 起不再收录，存量提交见 #432）
- `描述`: Chinese description of the change

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
[F20260721xxxx][module][Feature Update][Incompatible] 描述
```

## PR Title

Same format as commit message. PR number is appended by GitHub automatically.

## PR Flow

### Mandatory Rules

1. **PR-only delivery**: All code changes must be delivered via PR, never direct push
2. **No direct push to protected branches**: `main`, `develop`, `production` are protected
3. **Separation of duties**: Developer cannot merge their own PR
4. **PR description 署名**：PR description 末尾署名行必须填写实际海獭名号（替换 `[海獭名号]`），未署名的 PR 不得创建（完整署名约定见 signature-convention skill）

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

> 以 `.github/pull_request_template.md` 为权威模板（GitHub 自动加载），此处仅为格式参考。两版结构差异：`.github` 版面向创建者（含 Why / Risks / Verification 等填空），此处版面面向检视者（突出 Discovered Issues 的 issue 链接要求）。

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

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by [海獭名号]
```
