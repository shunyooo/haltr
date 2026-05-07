//! `hal migrate hint` — emit a markdown migration brief for the calling agent.
//!
//! haltr ships infrastructure agent definitions (dispatcher, critic-orchestrator,
//! memory-writer) and one default critic (memory-feedback-reader) whose contracts
//! are coupled to the binary. When haltr is upgraded, those contracts may change
//! (see #5/#6/#4), but `hal setup` uses `write_if_missing` and intentionally
//! leaves existing files alone so user customizations survive.
//!
//! Rather than hardcoding upgrade logic in Rust (force-overwrite vs. merge), we
//! emit a structured markdown brief and let the *calling agent* in the user's
//! Claude Code session reconcile their on-disk file against the current bundled
//! version — preserving local edits where possible.

use anyhow::Result;

const MEMORY_WRITER: &str = include_str!("../agents/memory-writer.md");
const DISPATCHER: &str = include_str!("../agents/dispatcher.md");
const CRITIC_ORCHESTRATOR: &str = include_str!("../agents/critic-orchestrator.md");
const MEMORY_FEEDBACK_READER: &str = include_str!("../agents/critics/memory-feedback-reader.md");

const HALTR_VERSION: &str = env!("CARGO_PKG_VERSION");

struct AgentBrief {
    /// Path under `.haltr/` (e.g. `agents/memory-writer.md`).
    rel_path: &'static str,
    /// Why an upgrade may be needed and what concretely the binary expects.
    contract_summary: &'static str,
    /// A substring that MUST be present in the on-disk file for the binary to
    /// honor the current contract. If absent, the file is from an older haltr
    /// version and the agent should bring it forward.
    required_marker: &'static str,
    /// Bundled current content.
    bundled: &'static str,
}

const BUNDLED_AGENTS: &[AgentBrief] = &[
    AgentBrief {
        rel_path: "agents/memory-writer.md",
        contract_summary: "\
The Stop hook now passes inputs INLINE in the prompt (no `transcript_path` lookup) \
and expects a structured JSON response: `{\"wrote\": true|false, \"slug\": \"...\"|null, \"reason\": \"...\"}`. \
If your local file still describes reading `transcript_path` directly or returning markdown, \
the memory layer will fail with `error_kind: parse_error` (see #5, #6).",
        required_marker: "\"wrote\"",
        bundled: MEMORY_WRITER,
    },
    AgentBrief {
        rel_path: "agents/critics/memory-feedback-reader.md",
        contract_summary: "\
memory-feedback-reader must append a fenced ```haltr-stats``` block at the end of its verdict, \
listing `checked` and `matched` entries. The Stop hook parses this fence and updates per-entry \
counters in `.haltr/memory/00_stats.json`. Without the fence, `hal memory stats` will stay empty (see #4).",
        required_marker: "haltr-stats",
        bundled: MEMORY_FEEDBACK_READER,
    },
    AgentBrief {
        rel_path: "agents/dispatcher.md",
        contract_summary: "\
Layer 1 router. Ships with the binary and rarely needs migration. Included here for completeness; \
upgrade only if you've never customized it and want to pick up upstream wording tweaks.",
        required_marker: "",
        bundled: DISPATCHER,
    },
    AgentBrief {
        rel_path: "agents/critic-orchestrator.md",
        contract_summary: "\
Critic panel orchestrator. Same status as dispatcher — bundled, rarely changes, no hard contract \
required by the binary beyond returning `{\"decision\":...,\"findings\":[...]}`.",
        required_marker: "",
        bundled: CRITIC_ORCHESTRATOR,
    },
];

pub fn hint() -> Result<()> {
    let mut out = String::new();
    out.push_str(&format!("# haltr migration brief (haltr {})\n\n", HALTR_VERSION));
    out.push_str("\
You are an agent operating in a project that uses haltr. The user wants to bring \
their `.haltr/` agent definitions up to date with the haltr binary currently installed.\n\
\n\
For each section below:\n\
\n\
1. Read the user's current file at the listed path.\n\
2. If the file does not exist, write the bundled version verbatim.\n\
3. If it exists, **preserve user customizations** while honoring the contract \
described in *Required contract*. The bundled version below is the reference shape — \
treat it as authoritative for binary-coupled requirements (input format, output \
format, required output markers), but do not blow away local edits to wording, \
examples, or sections the user has clearly customized.\n\
4. The *Required marker* is a substring that must appear somewhere in the final \
file for the binary to honor the contract.\n\
\n\
After applying changes, the user can verify with:\n\
\n\
```\n\
hal hook stop --help   # binary still works\n\
ls .haltr/agents/      # files in place\n\
```\n\
\n\
---\n\n");

    for brief in BUNDLED_AGENTS {
        out.push_str(&format!("## `.haltr/{}`\n\n", brief.rel_path));
        out.push_str("### Required contract\n\n");
        out.push_str(brief.contract_summary);
        out.push_str("\n\n");
        if !brief.required_marker.is_empty() {
            out.push_str(&format!("**Required marker** (must appear in the final file): `{}`\n\n", brief.required_marker));
        }
        out.push_str("### Bundled current version\n\n");
        out.push_str("```markdown\n");
        out.push_str(brief.bundled);
        if !brief.bundled.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("```\n\n");
        out.push_str("---\n\n");
    }

    print!("{}", out);
    Ok(())
}

/// Used by the Stop hook compat check: returns the on-disk file paths that
/// are missing their required marker (relative to `.haltr/`).
pub fn detect_outdated(haltr_dir: &str) -> Vec<&'static str> {
    let mut outdated = Vec::new();
    for brief in BUNDLED_AGENTS {
        if brief.required_marker.is_empty() {
            continue;
        }
        let path = format!("{}/{}", haltr_dir, brief.rel_path);
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                if !content.contains(brief.required_marker) {
                    outdated.push(brief.rel_path);
                }
            }
            Err(_) => {
                // Missing file — also flag as outdated so the user re-runs setup.
                outdated.push(brief.rel_path);
            }
        }
    }
    outdated
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_haltr() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("haltr-migrate-test-{}-{}", std::process::id(), id));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("agents/critics")).unwrap();
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn detect_outdated_flags_missing_files() {
        let dir = tmp_haltr();
        let outdated = detect_outdated(&dir);
        // Both contract-bearing files are missing → both flagged.
        assert!(outdated.contains(&"agents/memory-writer.md"));
        assert!(outdated.contains(&"agents/critics/memory-feedback-reader.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_outdated_flags_files_without_marker() {
        let dir = tmp_haltr();
        std::fs::write(format!("{}/agents/memory-writer.md", dir), "old style — reads transcript_path directly\n").unwrap();
        std::fs::write(format!("{}/agents/critics/memory-feedback-reader.md", dir), "old style — markdown only\n").unwrap();
        let outdated = detect_outdated(&dir);
        assert!(outdated.contains(&"agents/memory-writer.md"));
        assert!(outdated.contains(&"agents/critics/memory-feedback-reader.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_outdated_clears_when_marker_present() {
        let dir = tmp_haltr();
        std::fs::write(format!("{}/agents/memory-writer.md", dir),
            "spec: agent must return {\"wrote\": ...}").unwrap();
        std::fs::write(format!("{}/agents/critics/memory-feedback-reader.md", dir),
            "must append a haltr-stats fence at the end").unwrap();
        let outdated = detect_outdated(&dir);
        assert!(!outdated.contains(&"agents/memory-writer.md"));
        assert!(!outdated.contains(&"agents/critics/memory-feedback-reader.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
