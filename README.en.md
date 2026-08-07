# Otter Buddy

[中文](./README.md) | English

Otter Buddy is an Agentic System built with Agent-first design, Chat as Substrate, and a memory system at its core.

## Design Philosophy

- **Agent-first**: The system is designed around agents as first-class citizens
- **Chat as Substrate**: Chat interface serves as the foundational interaction paradigm
- **Memory-driven**: Persistent memory powers long-term agent collaboration

For detailed design philosophy and architecture decisions, see [otter-buddy#3](https://github.com/chenlaicai/otter-buddy/issues/3).

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

### Prerequisites

- Node.js 22 (LTS)
- npm
- LLM API Key (OpenAI or Anthropic)

### Install dependencies

```bash
# Backend dependencies
npm install

# Frontend dependencies
cd web && npm install && cd ..
```

### Configure

Copy the config template and fill in your values:

```bash
cp config/config.yaml.example config/config.yaml
```

Edit `config/config.yaml` — at minimum, set these required fields:

```yaml
llm:
  models:
    - alias: default
      provider: openai      # openai / anthropic / kimi-coding
      model: gpt-4o
      apiKey: sk-...        # LLM API Key
```

> `config/config.yaml` is in `.gitignore` and will not be committed.

#### Migrating from .env

If you previously used `.env`, map your environment variables to `config/config.yaml`:

| Environment variable | config.yaml field |
|---------------------|-------------------|
| `OTTER_BUDDY_LLM_PROVIDER` | `llm.models[].provider` |
| `OTTER_BUDDY_LLM_MODEL` | `llm.models[].model` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `llm.models[].apiKey` |
| `OTTER_BUDDY_PORT` | `server.port` |
| `OTTER_BUDDY_DB_PATH` | `database.path` |

### Build frontend

```bash
cd web && npm run build && cd ..
```

### Start the system

```bash
npm start
```

Open http://localhost:3000 to start chatting.

### Development mode

Run frontend and backend separately with hot reload:

```bash
# Terminal 1: Backend (TypeScript compile + start)
npm start

# Terminal 2: Frontend (Vite dev server, proxies /api to backend)
cd web && npm run dev
```

Frontend dev server runs at http://localhost:5173 and automatically proxies `/api` requests to the backend at `http://localhost:3000`.

### Run tests

```bash
npm test
```

### Full check (lint + build)

```bash
npm run check
```

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│  Web Frontend (React + Vite)                         │
│  web/ → http://localhost:5173 (dev) / :3000 (prod)   │
│  Pages: Chat · Memory · Skills · Settings            │
└──────────────────┬──────────────────────────────────┘
                   │ /api/* (REST + SSE)
┌──────────────────▼──────────────────────────────────┐
│  Backend (Hono + Node.js)                            │
│  src/main.ts → http://localhost:3000                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │ Controllers  │ │ Use Cases    │ │ Frameworks   │ │
│  │ (HTTP/REST)  │→│ (Business)   │→│ (DB/LLM/Emb) │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ │
│  ┌──────────────┐                                    │
│  │ Agent Runtime│ (Pi Agent + Tools)                 │
│  └──────────────┘                                    │
└─────────────────────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │ SQLite (better-sqlite3) │
        │ Vectors (sqlite-vec)    │
        └─────────────────────┘
```

## Project Structure

```
otter-buddy/
├── api-contract/     # Shared TypeScript types (DTO + SSE events)
├── web/              # React frontend (Vite + Tailwind CSS)
│   ├── src/          # Frontend source (React components, API client)
│   ├── index.html    # Chat page entry
│   ├── memory.html   # Memory page entry
│   ├── skills.html   # Skills page entry
│   └── settings.html # Settings page entry
├── src/              # Backend source (Clean Architecture)
│   ├── frameworks/       # Framework layer (DB, LLM, Embedding, Config)
│   ├── usecases/         # Use case layer (business logic)
│   ├── interface-adapters/# Interface adapters (HTTP controllers, Agent Runtime)
│   └── main.ts           # Composition Root (dependency injection)
├── tests/            # Tests
├── .github/          # GitHub config (CI, issue templates, PR template, etc.)
├── .githooks/        # Git hooks (commit conventions, branch protection)
├── docs/             # Project documentation
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── vitest.config.ts
```

## License

[MIT](./LICENSE)
