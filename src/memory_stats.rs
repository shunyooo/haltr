//! Per-entry memory statistics: how often each entry has been checked vs
//! actually matched as a recurrence. Stats are accumulated by the Stop hook
//! after each critic verdict and inspected via the `hal memory stats` /
//! `hal memory hits` CLI commands.
//!
//! Source of truth for *aggregate counts* is `.haltr/memory/00_stats.json`.
//! Source of truth for *individual hit events* is the per-session log file
//! `.haltr/logs/<sid>.jsonl` (verdict layer findings); the stats file only
//! holds counters and the latest timestamps.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntryStat {
    #[serde(default)]
    pub checks: u64,
    #[serde(default)]
    pub hits: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_check: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_hit: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stats {
    #[serde(default)]
    pub entries: BTreeMap<String, EntryStat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// `.haltr/memory/00_stats.json` path under a haltr dir.
pub fn stats_path(haltr_dir: &str) -> String {
    format!("{}/memory/00_stats.json", haltr_dir)
}

/// Load stats from disk. Missing or malformed file → default (empty) stats.
/// fail-open by design: stat tracking must never break the hook pipeline.
pub fn load(path: &str) -> Stats {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => Stats::default(),
    }
}

pub fn save(path: &str, stats: &Stats) -> Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(stats)
        .context("failed to serialize memory stats")?;
    std::fs::write(path, json + "\n")
        .with_context(|| format!("failed to write {}", path))?;
    Ok(())
}

/// Apply a single critic run to the stats file. Increments `checks` for every
/// entry in `checked` and `hits` for every entry in `matched`. The matched set
/// is treated as a subset of checked: if an entry appears only in `matched`,
/// it is also counted as a check.
pub fn record_run(
    path: &str,
    checked: &[String],
    matched: &[String],
    now_rfc3339: &str,
) -> Result<()> {
    let mut stats = load(path);

    let mut all: BTreeMap<String, ()> = BTreeMap::new();
    for e in checked {
        all.insert(e.clone(), ());
    }
    for e in matched {
        all.insert(e.clone(), ());
    }

    for entry in all.keys() {
        let stat = stats.entries.entry(entry.clone()).or_default();
        stat.checks += 1;
        stat.last_check = Some(now_rfc3339.to_string());
    }
    for entry in matched {
        let stat = stats.entries.entry(entry.clone()).or_default();
        stat.hits += 1;
        stat.last_hit = Some(now_rfc3339.to_string());
    }

    stats.updated_at = Some(now_rfc3339.to_string());
    save(path, &stats)
}

/// Extract the haltr-stats JSON block from a verbatim memory-feedback-reader
/// finding `detail`. Returns `(checked, matched)` lists of entry filenames,
/// or `None` if no parseable block is present.
///
/// The expected fence shape inside the markdown is:
///
/// ```text
/// ```haltr-stats
/// {"checked": ["a.md", "b.md"], "matched": [{"entry": "a.md", "severity": "red"}]}
/// ```
/// ```
pub fn extract_haltr_stats(detail: &str) -> Option<(Vec<String>, Vec<String>)> {
    let mut in_block = false;
    let mut json_lines: Vec<&str> = Vec::new();

    for line in detail.lines() {
        let trimmed = line.trim_start();
        if !in_block {
            if trimmed.starts_with("```haltr-stats") {
                in_block = true;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            break;
        }
        json_lines.push(line);
    }

    if json_lines.is_empty() {
        return None;
    }

    let raw = json_lines.join("\n");
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let checked: Vec<String> = parsed.get("checked")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let matched: Vec<String> = parsed.get("matched")
        .and_then(|v| v.as_array())
        .map(|a| a.iter()
            .filter_map(|x| x.get("entry").and_then(|e| e.as_str()).map(String::from))
            .collect())
        .unwrap_or_default();

    Some((checked, matched))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir()
            .join(format!("haltr-stats-test-{}-{}-{}.json", std::process::id(), id, name));
        let _ = std::fs::remove_file(&p);
        p.to_string_lossy().to_string()
    }

    #[test]
    fn load_missing_file_returns_default() {
        let s = load("/nonexistent/path/00_stats.json");
        assert!(s.entries.is_empty());
        assert!(s.updated_at.is_none());
    }

    #[test]
    fn load_invalid_json_returns_default() {
        let path = tmp_path("invalid");
        std::fs::write(&path, "not json").unwrap();
        let s = load(&path);
        assert!(s.entries.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_run_increments_counters() {
        let path = tmp_path("record");
        let checked = vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()];
        let matched = vec!["b.md".to_string()];
        record_run(&path, &checked, &matched, "2026-05-07T08:00:00Z").unwrap();

        let s = load(&path);
        assert_eq!(s.entries.len(), 3);
        assert_eq!(s.entries["a.md"].checks, 1);
        assert_eq!(s.entries["a.md"].hits, 0);
        assert_eq!(s.entries["b.md"].checks, 1);
        assert_eq!(s.entries["b.md"].hits, 1);
        assert_eq!(s.entries["c.md"].checks, 1);
        assert_eq!(s.entries["c.md"].hits, 0);
        assert_eq!(s.updated_at.as_deref(), Some("2026-05-07T08:00:00Z"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_run_accumulates_across_calls() {
        let path = tmp_path("accumulate");
        record_run(&path, &["a.md".to_string()], &[], "2026-05-07T08:00:00Z").unwrap();
        record_run(&path, &["a.md".to_string()], &["a.md".to_string()], "2026-05-07T09:00:00Z").unwrap();
        record_run(&path, &["a.md".to_string()], &[], "2026-05-07T10:00:00Z").unwrap();

        let s = load(&path);
        assert_eq!(s.entries["a.md"].checks, 3);
        assert_eq!(s.entries["a.md"].hits, 1);
        assert_eq!(s.entries["a.md"].last_check.as_deref(), Some("2026-05-07T10:00:00Z"));
        assert_eq!(s.entries["a.md"].last_hit.as_deref(), Some("2026-05-07T09:00:00Z"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_run_counts_matched_only_entry_as_checked() {
        // Defensive: if memory-feedback-reader produces matched without
        // listing the entry in checked, we still count it as a check.
        let path = tmp_path("matched-only");
        record_run(&path, &[], &["a.md".to_string()], "2026-05-07T08:00:00Z").unwrap();
        let s = load(&path);
        assert_eq!(s.entries["a.md"].checks, 1);
        assert_eq!(s.entries["a.md"].hits, 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn extract_finds_simple_block() {
        let detail = r#"# memory-feedback-reader verdict

severity: red

## Matched entries
- foo

```haltr-stats
{"checked": ["a.md", "b.md"], "matched": [{"entry": "a.md", "severity": "red"}]}
```
"#;
        let (checked, matched) = extract_haltr_stats(detail).expect("should extract");
        assert_eq!(checked, vec!["a.md", "b.md"]);
        assert_eq!(matched, vec!["a.md"]);
    }

    #[test]
    fn extract_handles_multiline_json() {
        let detail = r#"
```haltr-stats
{
  "checked": ["a.md", "b.md"],
  "matched": [
    {"entry": "b.md", "severity": "yellow"}
  ]
}
```
"#;
        let (checked, matched) = extract_haltr_stats(detail).expect("should extract");
        assert_eq!(checked, vec!["a.md", "b.md"]);
        assert_eq!(matched, vec!["b.md"]);
    }

    #[test]
    fn extract_returns_none_on_missing_fence() {
        assert!(extract_haltr_stats("plain text without fence").is_none());
    }

    #[test]
    fn extract_returns_none_on_invalid_json() {
        let detail = "```haltr-stats\nnot json\n```";
        assert!(extract_haltr_stats(detail).is_none());
    }
}
