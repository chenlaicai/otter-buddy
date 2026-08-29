# Contributing

> **Issues are welcome.** Pull requests are not accepted for now — this is a personal research project. If you'd like to see a change, please open an issue.
>
> 欢迎 issue。暂不接受 PR——这是个人研究项目。想看到某个改动，请开 issue。

以下为内部开发规范，供维护者参考。

## Development Setup

```bash
npm install
npm run check
```

## Commit Message Format

Commit messages must follow the template:

```
[FYYYYMMDDNN|FYYYYMMDDxNNN][module][Feature Update|BugFix|New Feature|Refactor|Design][Incompatible] 中文标题
```

- `FYYYYMMDDNN`: 8-digit date + 2-digit sequence number (legacy format)
- `FYYYYMMDDxNNN`: 8-digit date + 1 separator letter (a-k, m-n, p-z) + 3-9 char code (charset: 2-9a-km-np-z)
- Module: lowercase label (e.g. `agent`, `web`, `readme`, `memory`)
- Type tags: `Feature Update`, `BugFix`, `New Feature`, `Refactor`, `Design`
- `[Incompatible]` is optional, only when breaking changes exist
- First line must contain CJK characters

## Code Conventions

- Keep changes focused and complete: address the full validated problem and its necessary tests without unrelated churn.
- Run `npm run check` (lint + build) before committing.
- Tests: `npm test` for unit tests, `npm run test:capability` for capability tests.
- 涉及 LLM 行为（prompt/skill/工具选择/协议）的改动：F 文档声明 `capability_test`（用例路径或 n/a 理由），见 docs/README.md「能力测试约定」。
- 测试分层、能力测试配置与写作约定：见 [docs/user-guide/testing.md](docs/user-guide/testing.md)。

## Project Notes

Otter Buddy is an Agentic System with Chat as Substrate and memory at its core. Changes that affect persistence, agent behavior, memory system, or API should clearly describe compatibility and migration risks.
