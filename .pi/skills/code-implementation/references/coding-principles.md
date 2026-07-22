# Coding Principles

## Architecture Compliance

- Follow the project's layer constraints (e.g., Clean Architecture: domain → application → infrastructure)
- Do not skip layers — domain code should not directly call infrastructure
- Respect dependency direction: outer layers depend on inner layers, not vice versa

## Naming

- Match project terminology — use the same words the codebase uses for the same concepts
- When introducing a new term, check if an equivalent already exists
- Prefer descriptive names over abbreviated ones

## Code Quality

- Non-obvious logic MUST have a comment explaining the design intent (not what the code does, but WHY)
- No dead code — if it is not used, remove it
- No compatibility bridge code — the new design is the current design

## What NOT to Do

- Do not add backward-compatibility shims unless explicitly requested
- Do not add abstraction layers for hypothetical future requirements
- Do not refactor code outside the plan scope
- Do not add documentation, comments, or type annotations to code you did not change
