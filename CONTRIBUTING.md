# Contributing

## Development Setup

```bash
npm install
npm run check
```

## Pull Requests

- Keep changes focused and complete: address the full validated problem and its necessary tests without unrelated churn.
- Explain why the change is needed.
- Call out whether the change affects agent behavior, memory system, persistence, or API behavior.
- Run `npm run check` before opening a PR.
- 涉及 LLM 行为（prompt/skill/工具选择/协议）的改动：F 文档声明 `capability_test`（用例路径或 n/a 理由），见 docs/README.md「能力测试约定」。

## Commit Message Format

Commit messages must follow the template:

```
[FYYYYMMDDNN|FYYYYMMDDxNNN][module][Feature Update|BugFix|New Feature][Incompatible] 中文标题
```

- `FYYYYMMDDNN`: 8-digit date + 2-digit sequence number (legacy format)
- `FYYYYMMDDxNNN`: 8-digit date + 1 separator (x) + 3-char random code (charset: 2-9a-kmnp-z)
- `[Incompatible]` is optional, only when breaking changes exist
- First line must contain CJK characters

## Project Notes

Otter Buddy is an Agentic System with Chat as Substrate and memory at its core. Changes that affect persistence, agent behavior, memory system, or API should clearly describe compatibility and migration risks in the PR.
