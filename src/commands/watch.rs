use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader, IsTerminal};
use std::path::PathBuf;
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_millis(250);
const FINDING_DETAIL_MAX_LINES: usize = 4;
const INDENT: &str = "                          ";

pub fn run(session: Option<String>, no_follow: bool) -> Result<()> {
    let log_path = resolve_log_path(session.as_deref())?;
    let color = std::io::stdout().is_terminal();

    eprintln!("watching {}", log_path.display());

    let file = std::fs::File::open(&log_path)
        .with_context(|| format!("failed to open: {}", log_path.display()))?;
    let mut reader = BufReader::new(file);
    let mut state = WatchState::default();
    let mut buf = String::new();

    loop {
        buf.clear();
        let n = reader.read_line(&mut buf)?;
        if n == 0 {
            if no_follow {
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let entry: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        render(&entry, &mut state, color);
    }
    Ok(())
}

fn resolve_log_path(session: Option<&str>) -> Result<PathBuf> {
    let haltr_dir = find_haltr_dir()?;
    let logs_dir = haltr_dir.join("logs");

    if let Some(sid) = session {
        let exact = logs_dir.join(format!("{}.jsonl", sid));
        if exact.exists() {
            return Ok(exact);
        }
        if logs_dir.is_dir() {
            for entry in std::fs::read_dir(&logs_dir)? {
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(sid) && name.ends_with(".jsonl") {
                    return Ok(entry.path());
                }
            }
        }
        return Err(anyhow!(
            "no log file matching '{}' in {}",
            sid,
            logs_dir.display()
        ));
    }

    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    let dir = std::fs::read_dir(&logs_dir)
        .with_context(|| format!("failed to read {}", logs_dir.display()))?;
    for entry in dir {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(mt) = meta.modified() {
                candidates.push((path, mt));
            }
        }
    }
    candidates.sort_by_key(|(_, mt)| std::cmp::Reverse(*mt));
    candidates
        .into_iter()
        .next()
        .map(|(p, _)| p)
        .ok_or_else(|| anyhow!("no .jsonl files in {}", logs_dir.display()))
}

fn find_haltr_dir() -> Result<PathBuf> {
    let mut dir = std::env::current_dir()?;
    loop {
        let candidate = dir.join(".haltr");
        if candidate.is_dir() {
            return Ok(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    Err(anyhow!(
        "no .haltr directory found from {}",
        std::env::current_dir()?.display()
    ))
}

#[derive(Default)]
struct WatchState {
    turn: u32,
}

fn render(entry: &Value, state: &mut WatchState, color: bool) {
    let ts = entry.get("ts").and_then(|v| v.as_str()).unwrap_or("");
    let layer = entry.get("layer").and_then(|v| v.as_str()).unwrap_or("");
    let time = format_time(ts);

    match layer {
        "0b" => render_0b(&time, entry, state, color),
        "dispatcher" => render_dispatcher(&time, entry, state, color),
        "memory" => render_memory(&time, entry, state, color),
        "verdict" => render_verdict(&time, entry, state, color),
        _ => {}
    }
}

fn render_0b(time: &str, entry: &Value, state: &mut WatchState, color: bool) {
    let action = entry.get("action").and_then(|v| v.as_str()).unwrap_or("");
    if action == "pass" {
        state.turn += 1;
        let writes = entry
            .get("last_turn_writes")
            .or_else(|| entry.get("write_tools"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let tools = entry
            .get("last_turn_tools")
            .or_else(|| entry.get("tools"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        println!(
            "{} {}  {} detect     {} / {} since anchor",
            turn_col(state, color),
            time,
            cyan("L0b", color),
            pluralize(writes, "write"),
            pluralize(tools, "tool"),
        );
    } else if action == "skip" {
        let reason = entry
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("skip");
        println!(
            "     {}  {} {}       {}",
            dim(time, color),
            dim("L0b", color),
            dim("skip", color),
            dim(reason, color),
        );
    }
}

fn render_dispatcher(time: &str, entry: &Value, state: &WatchState, color: bool) {
    let action = entry.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let cost = entry.get("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let dur_ms = entry
        .get("duration_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cost_dur = format!("${:.3} / {}", cost, format_duration_ms(dur_ms));

    if action == "fail-open" {
        let reason = entry.get("reason").and_then(|v| v.as_str()).unwrap_or("");
        println!(
            "{} {}  {} {}   {} {}    {}",
            turn_col(state, color),
            time,
            yellow("L1 ", color),
            yellow("dispatch", color),
            yellow("fail-open:", color),
            reason,
            dim(&cost_dur, color),
        );
        return;
    }

    let critic_run = entry
        .get("critic_run")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let memory_run = entry
        .get("memory_run")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let critics: Vec<String> = entry
        .get("critic_selected")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mem_cat = entry
        .get("memory_category")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let reason = entry.get("reason").and_then(|v| v.as_str()).unwrap_or("");

    let summary = build_dispatch_summary(critic_run, &critics, memory_run, mem_cat, color);

    println!(
        "{} {}  {} {}   {:<48} {}",
        turn_col(state, color),
        time,
        cyan("L1 ", color),
        bold("dispatch", color),
        strip_color_for_width(&summary, 48),
        dim(&cost_dur, color),
    );
    if !reason.is_empty() {
        println!("{}↳ {}", INDENT, italic(reason, color));
    }
}

fn build_dispatch_summary(
    critic_run: bool,
    critics: &[String],
    memory_run: bool,
    mem_cat: &str,
    color: bool,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if critic_run {
        if critics.is_empty() {
            parts.push(yellow("critic[?]", color));
        } else {
            parts.push(format!("critic[{}]", critics.join(",")));
        }
    }
    if memory_run {
        let cat = if mem_cat.is_empty() { "?" } else { mem_cat };
        parts.push(format!("memory[{}]", cat));
    }
    if parts.is_empty() {
        return dim("SKIP", color);
    }
    parts.join(" + ")
}

fn render_memory(time: &str, entry: &Value, state: &WatchState, color: bool) {
    let action = entry.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let cost = entry.get("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let cost_str = if cost > 0.0 {
        format!("${:.3}", cost)
    } else {
        String::new()
    };

    match action {
        "done" => {
            let slug = entry.get("slug").and_then(|v| v.as_str()).unwrap_or("?");
            let reason = entry.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            println!(
                "{} {}  {} {}     wrote {:<32} {}",
                turn_col(state, color),
                time,
                cyan("L2 ", color),
                green("memory", color),
                slug,
                dim(&cost_str, color),
            );
            if !reason.is_empty() {
                println!("{}↳ {}", INDENT, italic(reason, color));
            }
        }
        "noop" => {
            let reason = entry
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("no correction");
            println!(
                "{} {}  {} {}     noop — {}",
                turn_col(state, color),
                time,
                cyan("L2 ", color),
                dim("memory", color),
                dim(reason, color),
            );
        }
        "failed" => {
            let kind = entry
                .get("error_kind")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let reason = entry.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            println!(
                "{} {}  {} {}   {} ({}): {}",
                turn_col(state, color),
                time,
                cyan("L2 ", color),
                yellow("memory", color),
                yellow("failed", color),
                kind,
                reason,
            );
        }
        _ => {}
    }
}

fn render_verdict(time: &str, entry: &Value, state: &mut WatchState, color: bool) {
    let decision = entry
        .get("decision")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cost = entry.get("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let dur_ms = entry
        .get("total_duration_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cost_dur = format!("${:.3} / {}", cost, format_duration_ms(dur_ms));
    let iter = entry
        .get("iteration")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Skip / skip-critic verdicts are noisy and already implied by dispatcher SKIP.
    if decision == "skip" || decision == "skip-critic" {
        return;
    }

    let (icon, label) = match decision {
        "block" => (red("✗", color), red("BLOCK", color)),
        "approve" => (green("✓", color), green("APPROVE", color)),
        "escalate" => (yellow("‼", color), yellow("ESCALATE", color)),
        "fail-open" => (yellow("⚠", color), yellow("FAIL-OPEN", color)),
        other => ("·".to_string(), other.to_string()),
    };

    let iter_str = if decision == "block" || decision == "escalate" {
        format!("iter {}/2", iter)
    } else {
        String::new()
    };

    println!(
        "{} {}  {}  verdict    {:<10} {:<28} {}",
        turn_col(state, color),
        time,
        icon,
        bold(&label, color),
        iter_str,
        dim(&cost_dur, color),
    );

    if let Some(reason) = entry.get("reason").and_then(|v| v.as_str()) {
        if !reason.is_empty() && reason != "null" {
            println!("{}↳ {}", INDENT, italic(&summarize(reason), color));
        }
    }

    if let Some(arr) = entry.get("findings").and_then(|v| v.as_array()) {
        for f in arr {
            render_finding(f, color);
        }
    }
}

fn render_finding(f: &Value, color: bool) {
    let critic = f.get("critic").and_then(|v| v.as_str()).unwrap_or("");
    let severity = f.get("severity").and_then(|v| v.as_str()).unwrap_or("");
    let title = f.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let detail = f.get("detail").and_then(|v| v.as_str()).unwrap_or("");

    let sev_marker = match severity {
        "red" => red("[red]", color),
        "yellow" => yellow("[yellow]", color),
        "" => String::new(),
        s => format!("[{}]", s),
    };

    println!(
        "{}↳ {} {} {}",
        INDENT,
        bold(critic, color),
        sev_marker,
        title
    );

    let detail_indent = format!("{}  ", INDENT);
    let lines: Vec<&str> = detail.lines().collect();
    let shown = lines.len().min(FINDING_DETAIL_MAX_LINES);
    for line in &lines[..shown] {
        println!("{}{}", detail_indent, dim(line, color));
    }
    if lines.len() > shown {
        println!(
            "{}{}",
            detail_indent,
            dim(
                &format!("… ({} more lines)", lines.len() - shown),
                color
            )
        );
    }
}

fn turn_col(state: &WatchState, _color: bool) -> String {
    if state.turn > 0 {
        format!("#{:<3}", state.turn)
    } else {
        "    ".to_string()
    }
}

fn pluralize(n: u64, word: &str) -> String {
    if n == 1 {
        format!("1 {}", word)
    } else {
        format!("{} {}s", n, word)
    }
}

/// First line of `s`, truncated to ~200 visible chars.
/// Verdict reasons can contain multi-line subprocess error dumps.
fn summarize(s: &str) -> String {
    let first = s.lines().next().unwrap_or("").trim();
    if first.chars().count() <= 200 {
        first.to_string()
    } else {
        let cut: String = first.chars().take(200).collect();
        format!("{}…", cut)
    }
}

fn format_time(ts: &str) -> String {
    if ts.len() >= 19 {
        ts[11..19].to_string()
    } else {
        ts.to_string()
    }
}

fn format_duration_ms(ms: u64) -> String {
    if ms == 0 {
        "—".to_string()
    } else if ms < 1000 {
        format!("{}ms", ms)
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        let mins = ms / 60_000;
        let secs = (ms % 60_000) / 1000;
        format!("{}m{:02}s", mins, secs)
    }
}

/// Pad to a visible-character width, ignoring ANSI escape sequences.
fn strip_color_for_width(s: &str, width: usize) -> String {
    let visible = visible_len(s);
    if visible >= width {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(width - visible))
    }
}

fn visible_len(s: &str) -> usize {
    let mut len = 0;
    let mut in_esc = false;
    for c in s.chars() {
        if in_esc {
            if c == 'm' {
                in_esc = false;
            }
            continue;
        }
        if c == '\x1b' {
            in_esc = true;
            continue;
        }
        len += 1;
    }
    len
}

fn dim(s: &str, c: bool) -> String {
    if c { format!("\x1b[2m{}\x1b[0m", s) } else { s.to_string() }
}
fn red(s: &str, c: bool) -> String {
    if c { format!("\x1b[31m{}\x1b[0m", s) } else { s.to_string() }
}
fn green(s: &str, c: bool) -> String {
    if c { format!("\x1b[32m{}\x1b[0m", s) } else { s.to_string() }
}
fn yellow(s: &str, c: bool) -> String {
    if c { format!("\x1b[33m{}\x1b[0m", s) } else { s.to_string() }
}
fn cyan(s: &str, c: bool) -> String {
    if c { format!("\x1b[36m{}\x1b[0m", s) } else { s.to_string() }
}
fn bold(s: &str, c: bool) -> String {
    if c { format!("\x1b[1m{}\x1b[0m", s) } else { s.to_string() }
}
fn italic(s: &str, c: bool) -> String {
    if c { format!("\x1b[3m{}\x1b[0m", s) } else { s.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_time_extracts_hms() {
        assert_eq!(format_time("2026-05-08T10:23:45Z"), "10:23:45");
    }

    #[test]
    fn format_time_short_passthrough() {
        assert_eq!(format_time("2026-05-08"), "2026-05-08");
    }

    #[test]
    fn format_duration_zero() {
        assert_eq!(format_duration_ms(0), "—");
    }

    #[test]
    fn format_duration_sub_second() {
        assert_eq!(format_duration_ms(500), "500ms");
    }

    #[test]
    fn format_duration_seconds() {
        assert_eq!(format_duration_ms(2_500), "2.5s");
    }

    #[test]
    fn format_duration_minutes() {
        assert_eq!(format_duration_ms(86_000), "1m26s");
    }

    #[test]
    fn visible_len_strips_ansi() {
        let s = "\x1b[31mred\x1b[0m";
        assert_eq!(visible_len(s), 3);
    }

    #[test]
    fn dispatch_summary_skip_when_neither_runs() {
        let s = build_dispatch_summary(false, &[], false, "", false);
        assert_eq!(s, "SKIP");
    }

    #[test]
    fn dispatch_summary_critic_only() {
        let s = build_dispatch_summary(true, &["expert-skeptic".to_string()], false, "", false);
        assert_eq!(s, "critic[expert-skeptic]");
    }

    #[test]
    fn dispatch_summary_both() {
        let s = build_dispatch_summary(
            true,
            &["expert-skeptic".to_string()],
            true,
            "strong-correction",
            false,
        );
        assert_eq!(s, "critic[expert-skeptic] + memory[strong-correction]");
    }

    #[test]
    fn turn_col_blank_before_first_turn() {
        let state = WatchState { turn: 0 };
        assert_eq!(turn_col(&state, false), "    ");
    }

    #[test]
    fn turn_col_after_first_turn() {
        let state = WatchState { turn: 3 };
        assert_eq!(turn_col(&state, false), "#3  ");
    }

    #[test]
    fn pluralize_singular() {
        assert_eq!(pluralize(1, "write"), "1 write");
    }

    #[test]
    fn pluralize_plural() {
        assert_eq!(pluralize(0, "tool"), "0 tools");
        assert_eq!(pluralize(5, "tool"), "5 tools");
    }

    #[test]
    fn summarize_takes_first_line() {
        let s = "first line\nsecond line\nthird";
        assert_eq!(summarize(s), "first line");
    }

    #[test]
    fn summarize_truncates_long() {
        let s = "x".repeat(300);
        let out = summarize(&s);
        assert_eq!(out.chars().count(), 201); // 200 + ellipsis
        assert!(out.ends_with('…'));
    }
}
