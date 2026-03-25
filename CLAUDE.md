# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is haltr

haltr is a CLI tool (`hal`) that helps coding agents maintain quality during long-running tasks. It provides task/step state management via task.yaml, quality gates (accept criteria + verification), and a Stop hook that prevents agents from quitting before completing their work. Published to npm as `haltr`.

## Commands

```bash
cargo build --release   # Build release binary
cargo test              # Run all tests (unit + integration, 20 tests)
cargo run -- --help     # Run with help
```

## Architecture

```
src/main.rs              CLI entrypoint (clap derive). All commands registered here.
src/commands/             Command handlers.
  task.rs                 task create (--file required), task edit
  step.rs                 step add/start/done/pause/resume/verify
  status.rs               Show task state
  check.rs                Stop hook gate (exit 0 = allow, exit 2 = block, output to stderr)
  session.rs              SessionStart hook (sets HALTR_SESSION_ID env var)
  setup.rs                Registers hooks in ~/.claude/settings.json
src/lib/
  task_utils.rs           resolve_task_file() — 3-level fallback: --file > session > cwd detect
  session.rs              Session→task mapping in ~/.haltr/sessions/ (global, not project-local)
  response.rs             Builds YAML responses for agent consumption
  hints.rs                All agent guidance strings (centralized)
  validator.rs            YAML load/save for task.yaml
src/types.rs              Rust types (TaskYaml, Step, HistoryEvent, Status, AcceptCriteria)
tests/integration.rs      Integration tests (CLI invocation via binary)
```

### Key design decisions

- **Tool, not framework**: No directory structure enforcement. Task files can be anywhere.
- **Session mapping**: `hal task create` and `hal step start` write to `~/.haltr/sessions/{session_id}` so subsequent commands and Stop hook can find the task file without `--file`.
- **Stop hook outputs to stderr**: Claude Code reads stderr from hooks, not stdout. `check.rs` uses `eprintln!` for block messages.
- **All commands accept `--file`**: Optional on all commands except `task create` (required). Falls back to session mapping, then cwd auto-detect.
- **Hooks schema**: Claude Code settings.json uses nested structure: `[{ "hooks": [{ "type": "command", "command": "..." }] }]`

## Language

All code, user-facing strings, and documentation are in English.
