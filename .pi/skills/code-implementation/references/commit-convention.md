# Commit Convention

## Message Format

```
[FYYYYMMDDxxxx][module][type] 描述
```

- `FYYYYMMDDxxxx`: Feature number (immutable once assigned)
- `module`: Affected module name (e.g., `skills`, `agent-runtime`, `conversation`)
- `type`: One of `Feature`, `Feature Update`, `BugFix`, `Refactor`, `Design`, `New Feature`
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

### PR Workflow

```
1. Create worktree branch
2. Make changes and commit
3. Push branch: git push -u origin <branch>
4. Create PR: gh pr create
5. 召唤检视獭对抗审视（见 SKILL.md step 8；同一 PR 不超 2 轮，未决呈搭档裁决）
6. 审视通过 → 搭档终审并合入
7. Clean up worktree
```

### Forbidden Actions

- `git push origin main` — direct push to main
- `git push origin develop` — direct push to develop
- Merge your own PR — violates separation of duties
- Skip worktree for "small" changes — all changes need isolation

### PR Description Template

```markdown
## Summary
- What changed and why

## Changes
- File-by-file description

## Opportunistic Fixes
- List any issues found and fixed outside plan scope (same module/file/function)
- If none, write "无"

## Discovered Issues
- List any issues found but not fixed in this PR, with issue numbers
- If none, write "无"

## Test plan
- [ ] Verification steps

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
