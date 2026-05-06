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
│   └── INDEX.md                   # Learned correction entries
└── logs/
    └── {session_id}.jsonl         # Execution logs
```

And registers the Stop hook in `.claude/settings.json`.

## Commands

| Command | Description |
|---|---|
| `hal setup` | Initialize .haltr/ and register Stop hook |
| `hal critic enable` | Enable critic for current session |
| `hal critic disable` | Disable critic for current session |
| `hal critic enable --all` | Enable globally |
| `hal critic disable --all` | Disable globally |

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

## Design decisions

- **Rust for hook logic**: Shell scripting caused SIGPIPE, quoting, and grep bugs in the prototype. Rust avoids all of these.
- **`--system-prompt-file`** instead of `--agent`: Keeps all haltr assets under `.haltr/`, not `.claude/agents/`.
- **Fail-open**: Every error path exits 0. haltr never locks out the user due to its own bugs.
- **Session-level control**: Enable/disable per session, not just globally.

## License

MIT
