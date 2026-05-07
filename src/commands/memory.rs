//! `hal memory ...` subcommands: inspect the per-entry hit/check stats and
//! drill back from a counter into the individual hit events recorded in the
//! session logs.

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::path::PathBuf;

use crate::memory_stats;

pub fn stats() -> Result<()> {
    let haltr_dir = find_haltr_dir()?;
    let path = memory_stats::stats_path(&haltr_dir);
    let s = memory_stats::load(&path);

    if s.entries.is_empty() {
        println!("No memory stats yet ({}).", path);
        return Ok(());
    }

    let mut rows: Vec<(String, &memory_stats::EntryStat)> = s.entries.iter()
        .map(|(k, v)| (k.clone(), v))
        .collect();
    rows.sort_by(|a, b| b.1.hits.cmp(&a.1.hits).then(b.1.checks.cmp(&a.1.checks)));

    let entry_w = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(20).max(20);
    println!(
        "{:<entry_w$}  {:>6}  {:>4}  {:>6}  LAST HIT",
        "ENTRY", "CHECKS", "HITS", "RATE",
        entry_w = entry_w,
    );
    for (name, st) in &rows {
        let rate = if st.checks > 0 {
            format!("{:>5.1}%", (st.hits as f64 / st.checks as f64) * 100.0)
        } else {
            "  -  ".to_string()
        };
        let last = st.last_hit.as_deref().unwrap_or("-");
        println!(
            "{:<entry_w$}  {:>6}  {:>4}  {:>6}  {}",
            name, st.checks, st.hits, rate, last,
            entry_w = entry_w,
        );
    }

    if let Some(ts) = &s.updated_at {
        println!("\n(stats updated at {})", ts);
    }

    Ok(())
}

pub fn hits(entry: &str) -> Result<()> {
    let haltr_dir = find_haltr_dir()?;
    let logs_dir = PathBuf::from(&haltr_dir).join("logs");

    if !logs_dir.is_dir() {
        return Err(anyhow!("no logs directory at {}", logs_dir.display()));
    }

    let mut events: Vec<HitEvent> = Vec::new();
    let entries = std::fs::read_dir(&logs_dir)
        .with_context(|| format!("failed to read {}", logs_dir.display()))?;

    for dirent in entries.flatten() {
        let path = dirent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for line in content.lines() {
            let v: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("layer").and_then(|x| x.as_str()) != Some("verdict") {
                continue;
            }
            let findings = match v.get("findings").and_then(|f| f.as_array()) {
                Some(a) => a,
                None => continue,
            };
            for f in findings {
                if f.get("critic").and_then(|c| c.as_str()) != Some("memory-feedback-reader") {
                    continue;
                }
                let detail = match f.get("detail").and_then(|d| d.as_str()) {
                    Some(d) => d,
                    None => continue,
                };
                let (_, matched) = match memory_stats::extract_haltr_stats(detail) {
                    Some(t) => t,
                    None => continue,
                };
                if !matched.iter().any(|m| m == entry) {
                    continue;
                }
                events.push(HitEvent {
                    ts: v.get("ts").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                    session_id: v.get("critic_session_id")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string(),
                    severity: extract_severity_for(detail, entry).unwrap_or_else(|| "?".to_string()),
                    detail_excerpt: excerpt(detail, 240),
                    log_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    if events.is_empty() {
        println!("No hits found for \"{}\".", entry);
        return Ok(());
    }

    events.sort_by(|a, b| a.ts.cmp(&b.ts));

    println!("{} hit{} found for \"{}\":\n",
        events.len(),
        if events.len() == 1 { "" } else { "s" },
        entry,
    );
    for (i, ev) in events.iter().enumerate() {
        println!(
            "[{}] {}  session={}  severity={}",
            i + 1, ev.ts, ev.session_id, ev.severity,
        );
        for line in ev.detail_excerpt.lines() {
            println!("    {}", line);
        }
        println!("    log: {}", ev.log_path);
        println!();
    }

    Ok(())
}

struct HitEvent {
    ts: String,
    session_id: String,
    severity: String,
    detail_excerpt: String,
    log_path: String,
}

fn extract_severity_for(detail: &str, entry: &str) -> Option<String> {
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
    let raw = json_lines.join("\n");
    let v: Value = serde_json::from_str(&raw).ok()?;
    let arr = v.get("matched")?.as_array()?;
    for m in arr {
        if m.get("entry").and_then(|x| x.as_str()) == Some(entry) {
            return m.get("severity").and_then(|s| s.as_str()).map(String::from);
        }
    }
    None
}

fn excerpt(detail: &str, max_chars: usize) -> String {
    // Strip the haltr-stats fence and its JSON contents — that's machine
    // metadata, not what the user wants to see when drilling into a hit.
    let mut lines: Vec<&str> = Vec::new();
    let mut in_stats = false;
    for line in detail.lines() {
        let trimmed = line.trim_start();
        if !in_stats && trimmed.starts_with("```haltr-stats") {
            in_stats = true;
            continue;
        }
        if in_stats {
            if trimmed.starts_with("```") {
                in_stats = false;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            continue;
        }
        lines.push(line);
    }
    let joined = lines.join("\n").trim().to_string();
    if joined.chars().count() <= max_chars {
        joined
    } else {
        let cut: String = joined.chars().take(max_chars).collect();
        format!("{}...", cut)
    }
}

fn find_haltr_dir() -> Result<String> {
    let mut dir = std::env::current_dir()?;
    loop {
        let candidate = dir.join(".haltr");
        if candidate.is_dir() {
            return Ok(candidate.to_string_lossy().to_string());
        }
        if !dir.pop() {
            break;
        }
    }
    Err(anyhow!("no .haltr directory found in any parent"))
}
