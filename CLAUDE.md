# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is haltr

haltr is a CLI tool (`hal`) that provides a Stop hook-based quality gate and learning pipeline for coding agents. It enforces quality through independent sub-agent review (critic) and accumulates user corrections over time (memory), ensuring agents don't repeat mistakes.

## Commands

```bash
cargo build --release   # Build release binary
cargo test              # Run all tests (integration, 10 tests)
cargo run -- --help     # Run with help
```

## Architecture

```
src/main.rs              CLI entrypoint (clap derive). Commands: setup, critic, hook stop.
src/commands/
  setup.rs               `hal setup` — generates .haltr/ structure, registers Stop hook
  critic.rs              `hal critic enable/disable` — session or global kill switch
src/hook/
  stop.rs                `hal hook stop` — Stop hook entrypoint (4-layer pipeline)
src/session.rs           Session state management (/tmp/haltr-{session_id}.json)
src/transcript.rs        Transcript parsing: turn slice extraction, tool call analysis

src/agents/              Agent definition templates (embedded in binary via include_str!)
  dispatcher.md          Unified dispatcher (haiku): decides critic? memory? both?
  critic-panel.md        Critic orchestrator (opus): parallel reviewers, verdict aggregation
  memory-feedback-reader.md  Reviewer: past correction recurrence detection
  memory-writer.md       Learning pipeline: user correction → structured memory entry

tests/integration.rs     Integration tests (CLI invocation via binary)
```

### Stop hook flow (hal hook stop)

```
Layer 0a: recursion guard (CLAUDE_HOOK_NESTED) + kill switch (global + session)
Layer 0b: transcript analysis in Rust (turn slice, Edit/Write presence check)
Layer 1:  unified dispatcher (haiku, --system-prompt-file) → critic? memory? both?
Layer 2:  parallel execution: critic-panel and/or memory-writer (opus)
Verdict:  critic result → exit 0 (approve) or exit 2 (block + stderr findings)
```

### Generated project structure (hal setup)

```
.haltr/
├── agents/              Agent definitions for claude -p --system-prompt-file
├── memory/              INDEX.md + structured correction entries
└── logs/                {session_id}.jsonl execution logs

.claude/settings.json    Stop hook registration (command: "hal hook stop")
```

### Key design decisions

- **Rust for hook logic**: Avoids shell scripting bugs (SIGPIPE, quoting, grep). JSON via serde.
- **`--system-prompt-file`** instead of `--agent`: keeps all haltr assets under `.haltr/`
- **Session state**: single JSON file at `/tmp/haltr-{session_id}.json`
- **Fail-open**: any error in the pipeline → exit 0 (never lock out the user)
- **Agent invocation**: `claude -p --system-prompt-file ... --settings '{"disableAllHooks":true}' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json`

## Language

All code, user-facing strings, and documentation are in English.
