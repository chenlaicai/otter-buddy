# Otter Buddy

[中文](./README.md) | English

---

**Multi-agent system. They have names.**

A multi-agent collaboration system that has been running for months and is still working every day. The agents here aren't anonymous API calls — they're named team members with memory, craft, and discipline.

![Conversation UI](docs/images/conversation.jpg)

## The 30-second version

You only ever talk to one otter — **the Lead Otter**. It listens, then decides: handle it directly, or summon sub-otters for the job. The sub-otters review each other, argue, raise objections — and bring back results with evidence for you to decide.

It's not a framework. It's a **living system**: it runs a daily health check on itself, files its own issues, remembers a decision you made three months ago in passing — and the otter that writes code is not allowed to review its own code.

## A day in the life of this system

**Assign work in the morning, collect the PR in the afternoon.** You toss over one line — "that number in the README looks stale, handle it" — and go to your meeting. By afternoon a PR is waiting: tests green, CI green, review trail complete. The reviewing otter offered two fixes (update the number / remove it entirely); the Lead Otter turned the final decision into an interactive card. You clicked a button. Total human input: under ten sentences.

**They argue — with rules.** Whoever writes code never reviews it. The reviewer must run on a *different model*: different training paths, non-overlapping blind spots — it sees the pits you can't. Objections can't be swallowed: an `objection` signal must carry an evidence anchor; a vague "feels wrong" is procedurally invalid; every ruling is recorded. The traffic lights don't eliminate conflict — they eliminate "pretending not to see".

**They remember what you forgot.** Long-term memory isn't search-and-forget top-k — there's progressive disclosure to keep context from exploding, a relation graph so conclusions stay traceable, and messages come with a "📜 memory provenance: we discussed this on Aug 13, the conclusion was…" line. Your AI no longer has amnesia every conversation.

**They restart — but they don't reset.** Each otter's identity is a continuum across sessions: the past life is sealed into an archive, the new one wakes with a handoff briefing — lineage traceable, conversations auditable. That's why they genuinely have names.

**Before they touch your repo, three gates.** Forced worktree isolation, everything goes through PRs, and merging requires your approval *quote* verbatim-matched — "I'll approve on my human's behalf" style goodwill inference gets stopped cold by mechanical verification. Brittleness is a feature, not a bug: better to miss and make you say it again than to guess.

**They run a daily health check on themselves.** Problems they notice go into a healing ledger; the daily check files issues — and each must come with a fix plan, "leave a comment to track" doesn't count. Once, the health check found six bugs in itself.

![Multi-Agent Orchestration Demo](docs/images/demo-multi-agent.gif)

## 📖 Read how they grew up

**[Otter Growth Diaries](docs/growth-series/)** (Chinese) — an 8-episode mini-theater told honestly: the naive expectations at day one, the face-slaps, the detours, and what forced each mechanism into existence. Includes real incidents like "the fix was written but never merged" and "rules were cleaned up, then 168 violations crept back in 8 days".

> No "look how smart our AI is" — only "why we were dumb back then, and how we got smarter".

## Quick Start

```bash
# Prerequisites: Node.js 22 + npm + an LLM API Key (OpenAI / Anthropic / Kimi etc.)
cp config/config.yaml.example config/config.yaml   # fill in your API key
./scripts/otter-buddy.sh start                     # install → build → start
```

Open http://localhost:3000 and start chatting. Multi-model mixing: configure multiple `llm.models[]` (alias + provider) in `config.yaml` — different otters can run on different models.

<details>
<summary><b>Advanced configuration</b> (ports / alpha validation env / multimodal declaration / git hooks / .env migration)</summary>

### Startup script & ports

`scripts/otter-buddy.sh` provides start / stop / restart / status. Multiple worktrees can run on different ports (`-p 3001`) without interfering.

### Alpha validation environment (port constitution)

`scripts/alpha.sh` manages worktree validation instances (F20260917alph): ports auto-allocated from the 3100-3198 even range, isolated data root `~/.otter/alpha/<worktree-hash>/`. **Never kill the main service on port 3000** — an occupied port is the answer; pick another one.

### Model input capability declaration (multimodal)

Models without vision must explicitly declare `input: ["text"]` — otherwise the template implicitly inherits `["text","image"]` and injected images cause silent hallucination (verified in F20260827mmdu). With the declaration, the SDK downgrades images to text placeholders automatically.

```yaml
llm:
  models:
    - alias: glm
      provider: anthropic
      model: glm-5.3
      input: ["text"]             # can't see images — must declare
    - alias: glm-flash
      input: ["text", "image"]    # supports vision
```

### Verify git hooks

`npm install`'s `prepare` script points hooks at `.githooks/`; if external tools override this, all hooks **silently stop working** (#476, #684 on record). Verify once after install: `npm run hooks:check`; run `npm run prepare` to self-heal.

### Migrating from .env

| Environment variable | config.yaml field |
|---------------------|-------------------|
| `OTTER_BUDDY_LLM_PROVIDER` | `llm.models[].provider` |
| `OTTER_BUDDY_LLM_MODEL` | `llm.models[].model` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `llm.models[].apiKey` |
| `OTTER_BUDDY_PORT` | `server.port` |
| `OTTER_BUDDY_DB_PATH` | `database.path` |

</details>

## Why sea otters

Sea otters aren't primates, but they have tools, craft, and culture. A group of otters is called a raft — floating on the same water, each foraging independently, holding hands and wrapping kelp so nobody drifts away.

This system works the same way: the raft is collaboration (one conversational substrate, a talking stone passed around), the kelp forest is memory (conclusions stored and growing, not searched and forgotten), and craft is skill (behavioral patterns with know-how, not exposed API calls).

AI doesn't need to look human to have civilization.

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│  Web Frontend (React + Vite)                         │
│  Pages: Chat · Memory · Skills · Settings            │
└──────────────────┬──────────────────────────────────┘
                   │ /api/* (REST + SSE)
┌──────────────────▼──────────────────────────────────┐
│  Backend (Hono + Node.js + TypeScript, Clean Arch)   │
│  Controllers → Use Cases → Frameworks                │
│  ┌──────────────┐                                    │
│  │ Agent Runtime│ (Pi Agent + Tools + Skills)        │
│  └──────────────┘                                    │
└──────────────────┬──────────────────────────────────┘
        ┌──────────▼──────────┐
        │ SQLite (better-sqlite3 + sqlite-vec vectors) │
        └─────────────────────┘
```

## Contributing

Issues are welcome — bug reports, ideas, and feature suggestions are all valuable contributions. Pull requests are not accepted for now: this is a personal research project with limited maintainer bandwidth. If you'd like a change, open an issue describing it.

For internal development conventions, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
