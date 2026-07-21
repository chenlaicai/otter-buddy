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
