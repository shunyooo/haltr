<p align="center">
  <h1 align="center">haltr</h1>
  <p align="center">
    Stop hook quality gate + learning pipeline for coding agents
  </p>
  <p align="center">
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  </p>
</p>

---

## What is haltr?

haltr enforces code quality through an independent critic pipeline that runs in Claude Code's Stop hook. Every time the agent tries to stop, haltr reviews the changes with sub-agents and blocks if quality issues are found.

It also learns from your corrections — when you tell the agent "that's wrong" or "don't do that", haltr captures the pattern and checks for recurrence in future reviews.

### Core idea

- **Hooks-as-Policy**: CLAUDE.md says "should". Hooks say "cannot". haltr uses hooks.
- **Echo-chamber prevention**: The main agent cannot skip or influence the review. Sub-agents run in isolated context.
- **Learning loop**: User corrections are persisted and checked against future changes.

## How it works

```
Agent tries to stop
  │
  ├── Layer 0b: Any Edit/Write in this turn? No → allow
  │
  ├── Layer 1: Dispatcher (haiku, ~5s, ~$0.05)
  │            Should we review? Which critics?
  │            No → allow
  │
  └── Layer 2: Critic orchestrator + Memory writer (opus, parallel, ~2min, ~$0.5-1.0)
               ├── Critics review the changes → block or approve
               └── Memory writer captures any user corrections
```

~80% of stops are filtered at Layer 0b (free, instant). ~10% at Layer 1. Only ~10% trigger a full review.

## Quick start

```bash
# Build
cargo build --release

# Install to PATH
ln -sf $(pwd)/target/release/hal /usr/local/bin/hal

# Initialize in your project
cd your-project
hal setup
```

`hal setup` creates:

```
.haltr/
├── agents/
│   ├── dispatcher.md              # Routes to critics
│   ├── critic-orchestrator.md     # Aggregates critic findings
│   ├── memory-writer.md           # Captures user corrections
│   └── critics/                   # Editable, add your own
│       ├── expert-skeptic.md
│       └── memory-feedback-reader.md
├── memory/
│   ├── 00_index.md                # Learned correction entries (index)
│   └── 00_stats.json              # Per-entry hit/check counters (auto-updated)
└── logs/
    └── {session_id}.jsonl         # Execution logs
```

And registers the Stop hook in `.claude/settings.json`.

## Commands

| Command | Description |
|---|---|
| `hal setup` | Initialize .haltr/ and register Stop hook |
| `hal enable` | Enable the Stop hook for current session |
| `hal disable` | Disable the Stop hook for current session |
| `hal enable --all` | Enable globally |
| `hal disable --all` | Disable globally |
| `hal memory stats` | Per-entry hit/check counters from `.haltr/memory/00_stats.json` |
| `hal memory hits <entry>` | Drill into log history for a specific memory entry |
| `hal migrate hint` | Emit migration brief for the calling agent (after upgrading the binary) |
| `hal watch [<session>]` | Tail and pretty-print the session log (defaults to newest) |

`hal hook stop` is the Stop hook entrypoint — called by Claude Code, not by users.

## Customizing critics

Critics live in `.haltr/agents/critics/`. Each `.md` file is a critic. `hal setup` creates defaults but never overwrites — edit freely.

To add a project-specific critic:

```bash
# Create a new critic
cat > .haltr/agents/critics/my-checker.md << 'EOF'
# my-checker critic

You check for [your concern here].

## What to look for
...

## Output
Return markdown with `severity: red | green` and findings.
EOF
```

It's automatically discovered and available to the dispatcher.

## Upgrading

`hal setup` is intentionally non-destructive — it uses write-if-missing for agent
definitions so your customizations survive. The downside: when haltr ships a new
contract (e.g. memory-writer's structured JSON output, memory-feedback-reader's
`haltr-stats` footer), your existing `.haltr/agents/*.md` files won't pick up the
change.

**The Stop hook detects this** by checking for required marker substrings on
each run. If a file looks out of date, the hook surfaces a `systemMessage`
warning telling you to run:

```bash
hal migrate hint
```

This emits a markdown migration brief: each contract-bearing agent file, what
the binary expects, the required marker, and the bundled current version inline.

You then ask your coding agent to apply it:

```
> hal migrate hint
> Read the brief above and update my .haltr/agents/ accordingly.
> Preserve any project-specific edits you find.
```

Because the agent reads the brief, it can intelligently merge your local
customizations with the new contract instead of blindly overwriting. haltr
doesn't ship a `--force-overwrite` flag on purpose — agents are better at this
kind of reconciliation than a stock 3-way merge.

## Design decisions

- **Rust for hook logic**: Shell scripting caused SIGPIPE, quoting, and grep bugs in the prototype. Rust avoids all of these.
- **`--system-prompt-file`** instead of `--agent`: Keeps all haltr assets under `.haltr/`, not `.claude/agents/`.
- **Fail-open**: Every error path exits 0. haltr never locks out the user due to its own bugs.
- **Session-level control**: Enable/disable per session, not just globally.
- **Migrations are agent-driven, not imperative**: `hal migrate hint` outputs the new contracts as markdown for the calling agent to apply. The binary doesn't force-overwrite files; the agent reconciles user customizations with the binary's expectations.

## License

MIT
