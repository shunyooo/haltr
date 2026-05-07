# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is haltr

haltr is a CLI tool (`hal`) that provides a Stop hook-based quality gate and learning pipeline for coding agents. It enforces quality through independent sub-agent review (critic) and accumulates user corrections over time (memory), ensuring agents don't repeat mistakes.

## Commands

```bash
cargo build --release   # Build release binary
cargo test              # Run all tests (unit + integration)
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
src/transcript.rs        Transcript parsing: conversation log builder, turn slice extraction

src/agents/              Agent definition templates (embedded in binary via include_str!)
  dispatcher.md          Unified dispatcher (haiku): decides critic? memory? both?
  critic-orchestrator.md Critic orchestrator (opus): parallel critics, verdict aggregation
  memory-writer.md       Learning pipeline: user correction → structured memory entry
  critics/               Default critic definitions (copied to .haltr/agents/critics/)
    expert-skeptic.md    Design/spec review + haltr-specific invariants (fail-open, recursion guard)
    memory-feedback-reader.md  Past correction recurrence detection via .haltr/memory/

tests/integration.rs     Integration tests (CLI invocation via binary)
```

### Stop hook flow (hal hook stop)

```
Layer 0a: recursion guard (CLAUDE_HOOK_NESTED) + kill switch (global + session)
Layer 0b: last turn Edit/Write check (Rust, instant)
Layer 1:  unified dispatcher (haiku, --model haiku, ~5s)
          receives chronological conversation log since last anchor
          decides: critic? memory? both? skip?
Layer 2:  parallel: critic-orchestrator + memory-writer (opus, ~2min)
          critic reads turn slice file (anchor → end)
          memory-writer receives conversation log + slice path inline (cwd-independent)
          critics are dynamically discovered from .haltr/agents/critics/
Verdict:  critic result → exit 0 (approve) or exit 2 (block + stderr findings)
Anchor:   updated only after Layer 2 runs (preserves context across skips)
Telemetry: memory layer logs action ∈ {done, noop, failed} + error_kind on failure
           consecutive same-error_kind failures (≥3) emit a `systemMessage`
           on stdout so the user sees a non-blocking warning
```

### Generated project structure (hal setup)

```
.haltr/
├── agents/
│   ├── dispatcher.md              # Infrastructure (write-if-missing)
│   ├── critic-orchestrator.md     # Infrastructure
│   ├── memory-writer.md           # Infrastructure
│   └── critics/                   # Editable, add your own
│       ├── expert-skeptic.md
│       └── memory-feedback-reader.md
├── memory/                        # INDEX.md + structured correction entries
└── logs/                          # {session_id}.jsonl (gitignored)

.claude/settings.json              # Stop hook registration
```

### Key design decisions

- **Rust for hook logic**: Avoids shell scripting bugs (SIGPIPE, quoting, grep). JSON via serde.
- **`--system-prompt-file`** instead of `--agent`: keeps all haltr assets under `.haltr/`
- **Dispatcher uses haiku**: explicit `--model haiku` for cost/speed. Critic uses default (opus).
- **Conversation log**: dispatcher receives chronological `[user]`/`[assistant]` log with tool calls, not flattened text.
- **Anchor-based slicing**: transcript position (`last_anchor_line`) advances only after Layer 2 runs. Skips preserve planning context.
- **Dynamic critic discovery**: `.haltr/agents/critics/*.md` scanned at runtime. Add/remove/rename freely.
- **Session state**: `/tmp/haltr-{session_id}.json` — critic_enabled, critic_iter, last_anchor_line.
- **Fail-open**: every error path → exit 0. haltr never locks out the user.
- **Sub-agent session_id logged**: each `claude -p` invocation's session_id is recorded for transcript tracing.
- **Sub-agent cwd = project root**: `claude -p` is spawned with `current_dir(project_root)` so `.haltr/` and slice files are reachable regardless of where the user's session was started.
- **memory-writer input is inline**: dispatcher category + conversation log are embedded in the prompt; the slice path is offered as an optional deep-dive resource. No dependency on transcript path access.

## Language

All code, user-facing strings, and documentation are in English.
