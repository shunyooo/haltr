# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is haltr

haltr is a CLI tool (`hal`) that helps coding agents maintain quality during long-running tasks. It provides task/step state management via task.yaml, quality gates (accept criteria + verification), and a Stop hook that prevents agents from quitting before completing their work. Published to npm as `haltr`.

## Commands

```bash
npm run build          # TypeScript compile (tsc)
npm test               # Run schema + commands tests (84 tests)
npm run test:schema    # Schema validation tests only (57 tests)
npm run test:commands  # Command unit tests only (27 tests)
npm run test:e2e       # E2E tests (uses hal CLI binary)
npm run catalog        # Sync-check commands → regenerate .catalog/output/
npm run lint           # Biome lint
npm run lint:fix       # Biome lint with auto-fix
```

Clean build (recommended after deleting files): `rm -rf dist && npm run build`

## Architecture

```
src/bin/hal.ts              CLI entrypoint (Commander.js). All commands registered here.
src/commands/               Command handlers. Each exports handle* functions.
  task.ts                   task create (--file required), task edit
  step.ts                   step add/start/done/pause/resume/verify
  status.ts                 Show task state
  check.ts                  Stop hook gate (exit 0 = allow, exit 2 = block, output to stderr)
  session.ts                SessionStart hook (sets HALTR_SESSION_ID env var)
  setup.ts                  Registers hooks in ~/.claude/settings.json
src/lib/
  task-utils.ts             resolveTaskFile() — 3-level fallback: --file > session > cwd detect
  session-manager.ts        Session→task mapping in ~/.haltr/sessions/ (global, not project-local)
  response-builder.ts       Builds YAML responses for agent consumption
  hints.ts                  All agent guidance strings (centralized)
  validator.ts              Ajv schema validation for task.yaml
src/schemas/task.schema.json  JSON Schema for task.yaml (discriminated union on history events)
src/types.ts                TypeScript types matching the schema
```

### Key design decisions

- **Tool, not framework**: No directory structure enforcement. Task files can be anywhere.
- **Session mapping**: `hal task create` and `hal step start` write to `~/.haltr/sessions/{session_id}` so subsequent commands and Stop hook can find the task file without `--file`.
- **Stop hook outputs to stderr**: Claude Code reads stderr from hooks, not stdout. `check.ts` uses `console.error` for block messages.
- **All commands accept `--file`**: Optional on all commands except `task create` (required). Falls back to session mapping, then cwd auto-detect.

### Catalog system

Two separate catalog systems exist:

- **`.catalog/`** — Command documentation catalog. `sync-check.ts` verifies `commands.ts` matches hal.ts, `stories.ts` defines CLI invocation scenarios, `runner.ts` executes them via shell, `generator.ts` produces markdown/JSON.
- **`src/catalog/`** — Message catalog (scenarios.ts + runner.ts). Tests command outputs by calling handler functions directly. Used by `npm run catalog` (the old system, may be deprecated).

### Test patterns

Tests use a custom runner (no test framework). Pattern:
```typescript
function test(name: string, fn: () => void): void { ... }
function expectThrows(fn: () => void, containsMsg?: string): void { ... }
```
Tests create temp dirs, write task.yaml files, call handlers directly, and verify file contents.

## Language

All code, user-facing strings, and documentation are in English.
