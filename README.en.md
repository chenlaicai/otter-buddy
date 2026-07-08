# Otter Buddy

[中文](./README.md) | English

Otter Buddy is an Agentic System built with Agent-first design, Chat as Substrate, and a memory system at its core.

## Design Philosophy

- **Agent-first**: The system is designed around agents as first-class citizens
- **Chat as Substrate**: Chat interface serves as the foundational interaction paradigm
- **Memory-driven**: Persistent memory powers long-term agent collaboration

For detailed design philosophy and architecture decisions, see [snail-shell#597](https://github.com/chenlaicai/snail-shell/issues/597).

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 22 (LTS) |
| Language | TypeScript |
| Backend Framework | Hono |
| Database | better-sqlite3 |
| Test Framework | Vitest |
| Lint | ESLint (flat config) |
| Package Manager | npm |

## Quick Start

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Run tests

```bash
npm test
```

### Full check (lint + build)

```bash
npm run check
```

## Project Structure

```
otter-buddy/
├── .github/          # GitHub config (CI, issue templates, PR template, etc.)
├── .githooks/        # Git hooks (commit conventions, branch protection)
├── config/           # Configuration files (to be added after architecture design)
├── data/file/        # Runtime data (knowledge, prompts, skills, SOPs)
├── docs/             # Project documentation
├── scripts/          # Scripts
├── src/              # Source code
├── tests/            # Tests
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── vitest.config.ts
```

## License

[MIT](./LICENSE)
