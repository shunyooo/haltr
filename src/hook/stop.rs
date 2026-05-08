use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::process::Command;

use crate::commands::migrate;
use crate::memory_stats;
use crate::session;
use crate::transcript;

const MAX_ITER: u32 = 2;
const DISPATCHER_BUDGET: &str = "0.30";
const PANEL_BUDGET: &str = "3.00";
const MEMORY_WRITER_BUDGET: &str = "0.50";

#[derive(Debug, Deserialize)]
struct DispatcherResponse {
    critic: Option<CriticDispatch>,
    memory: Option<MemoryDispatch>,
    #[allow(dead_code)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CriticDispatch {
    run: bool,
    #[serde(default)]
    critics: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MemoryDispatch {
    run: bool,
    #[allow(dead_code)]
    #[serde(default)]
    category: String,
}

#[derive(Debug, Deserialize)]
struct CriticPanelResponse {
    decision: String,
    #[serde(default)]
    findings: Vec<Value>,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Deserialize)]
struct MemoryWriterResponse {
    wrote: bool,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

const CONSECUTIVE_FAILURE_WARN_THRESHOLD: usize = 3;

struct CriticInfo {
    name: String,
    description: String,
    content: String,
}

pub fn run() -> Result<()> {
    // Layer 0a: recursion guard
    if std::env::var("CLAUDE_HOOK_NESTED").unwrap_or_default() == "1" {
        return Ok(());
    }

    // Layer 0a: global kill switch
    if session::is_globally_disabled() {
        return Ok(());
    }

    // Read stdin (hook input JSON)
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let hook_input: Value = serde_json::from_str(&input).unwrap_or(Value::Null);

    let session_id = hook_input.get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let transcript_path = hook_input.get("transcript_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // fail-open if transcript unavailable
    if transcript_path.is_empty() || !std::path::Path::new(&transcript_path).exists() {
        return Ok(());
    }

    // Layer 0a: session-level kill switch
    let mut state = session::load(&session_id);
    if !state.hook_enabled {
        return Ok(());
    }

    // Ensure log directory exists
    let haltr_dir = find_haltr_dir()?;
    let project_root = std::path::Path::new(&haltr_dir)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| haltr_dir.clone());
    let log_dir = format!("{}/logs", haltr_dir);
    std::fs::create_dir_all(&log_dir).ok();
    let log_file = format!("{}/{}.jsonl", log_dir, session_id);

    let t_start = std::time::Instant::now();

    // Layer 0b: transcript analysis (slice from last checked position)
    let turn = match transcript::extract_turn_slice(&transcript_path, &log_dir, &session_id, state.last_anchor_line)? {
        Some(t) => t,
        None => {
            append_log(&log_file, "0b", serde_json::json!({"action": "skip", "reason": "no new content since last check"}));
            return Ok(());
        }
    };

    let new_anchor = turn.total_lines;

    if turn.last_turn_write_count == 0 {
        append_log(&log_file, "0b", serde_json::json!({
            "action": "skip",
            "reason": "no write tools in last turn",
            "last_turn_tools": turn.last_turn_tool_count,
            "total_tools_since_anchor": turn.tool_count
        }));
        transcript::cleanup_turn_slice(&log_dir, &session_id);
        return Ok(());
    }

    append_log(&log_file, "0b", serde_json::json!({
        "action": "pass",
        "last_turn_tools": turn.last_turn_tool_count,
        "last_turn_writes": turn.last_turn_write_count,
        "total_tools_since_anchor": turn.tool_count,
        "total_writes_since_anchor": turn.write_tool_count
    }));

    // Discover available critics
    let agents_dir = format!("{}/agents", haltr_dir);
    let available_critics = discover_critics(&agents_dir);
    let critic_catalog = build_critic_catalog(&available_critics);

    // git status
    let git_status = Command::new("git")
        .args(["status", "--short"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).chars().take(1500).collect::<String>())
        .unwrap_or_default();

    // Layer 1: unified dispatcher
    let dispatcher_prompt = format!(
        r#"You are the unified dispatcher. Based on the information below, decide what to run.

== Available critics ==
{critic_catalog}

== Conversation since last review ==
{conversation_log}

== git status ==
{git_status}

Respond with pure JSON only (no markdown, no text before/after):
{{
  "critic": {{ "run": true|false, "critics": ["<name>", ...] }},
  "memory": {{ "run": true|false, "category": "strong-correction"|"soft-redirect"|"noise"|"ambiguous" }},
  "reason": "..."
}}

Only select critic names from the available critics list above."#,
        critic_catalog = critic_catalog,
        conversation_log = turn.conversation_log,
        git_status = git_status,
    );

    let t_dispatch = std::time::Instant::now();
    let dispatch_result = invoke_claude(
        &format!("{}/dispatcher.md", agents_dir),
        &dispatcher_prompt,
        DISPATCHER_BUDGET,
        Some("haiku"),
        &project_root,
    );

    let dispatch_duration = t_dispatch.elapsed().as_millis();

    let dispatch = match dispatch_result {
        Ok(resp) => {
            let cost = resp.cost;
            match parse_dispatch_response(&resp.text) {
                Ok(d) => {
                    append_log(&log_file, "dispatcher", serde_json::json!({
                        "action": "ok",
                        "critic_run": d.critic.as_ref().map(|c| c.run).unwrap_or(false),
                        "critic_selected": d.critic.as_ref().map(|c| &c.critics).cloned().unwrap_or_default(),
                        "memory_run": d.memory.as_ref().map(|m| m.run).unwrap_or(false),
                        "memory_category": d.memory.as_ref().map(|m| &m.category).cloned().unwrap_or_default(),
                        "reason": d.reason.as_deref().unwrap_or(""),
                        "cost_usd": cost,
                        "duration_ms": dispatch_duration,
                        "session_id": resp.session_id,
                    }));
                    d
                }
                Err(e) => {
                    append_log(&log_file, "dispatcher", serde_json::json!({
                        "action": "fail-open",
                        "reason": format!("parse error: {}", e),
                        "cost_usd": cost,
                        "duration_ms": dispatch_duration
                    }));
                    transcript::cleanup_turn_slice(&log_dir, &session_id);
                    return Ok(());
                }
            }
        }
        Err(e) => {
            append_log(&log_file, "dispatcher", serde_json::json!({
                "action": "fail-open",
                "reason": format!("invoke error: {}", e),
                "duration_ms": dispatch_duration
            }));
            transcript::cleanup_turn_slice(&log_dir, &session_id);
            return Ok(());
        }
    };

    let run_critic = dispatch.critic.as_ref().map(|c| c.run).unwrap_or(false);
    let run_memory = dispatch.memory.as_ref().map(|m| m.run).unwrap_or(false);

    if !run_critic && !run_memory {
        append_log(&log_file, "verdict", serde_json::json!({
            "decision": "skip",
            "total_duration_ms": t_start.elapsed().as_millis()
        }));
        transcript::cleanup_turn_slice(&log_dir, &session_id);
        return Ok(());
    }

    // Layer 2: parallel execution
    let selected_names = dispatch.critic.as_ref()
        .map(|c| c.critics.clone())
        .unwrap_or_default();

    // Build reviewer definitions for critic-panel (inline the content of selected critics)
    let critic_defs = build_selected_critic_defs(&available_critics, &selected_names);

    let critic_handle = if run_critic {
        let agents_dir_c = agents_dir.clone();
        let turn_slice_path = turn.slice_path.clone();
        let iter = state.critic_iter;
        let cwd_c = project_root.clone();
        Some(std::thread::spawn(move || {
            let prompt = format!(
                r#"Transcript path (current turn only): {turn_slice}

== Selected critics and their instructions ==
{critic_defs}

Launch each reviewer above as a parallel Task, passing the transcript path.
Aggregate their findings verbatim.

Respond with pure JSON only:
{{
  "decision": "block" | "approve",
  "reason": "<short summary>",
  "findings": [{{"critic":"...", "severity":"red"|"yellow", "title":"...", "detail":"<verbatim>"}}],
  "meta": {{"critics_used": {selected}, "iteration_hint": "{iter}"}}
}}"#,
                turn_slice = turn_slice_path,
                critic_defs = critic_defs,
                selected = serde_json::to_string(&selected_names).unwrap_or_else(|_| "[]".to_string()),
                iter = iter,
            );
            invoke_claude(
                &format!("{}/critic-orchestrator.md", agents_dir_c),
                &prompt,
                PANEL_BUDGET,
                None,
                &cwd_c,
            )
        }))
    } else {
        None
    };

    let memory_handle = if run_memory {
        let agents_dir_m = agents_dir.clone();
        let cwd_m = project_root.clone();
        let category = dispatch.memory.as_ref()
            .map(|m| m.category.clone())
            .unwrap_or_default();
        let conversation_log = turn.conversation_log.clone();
        let slice_path = turn.slice_path.clone();
        Some(std::thread::spawn(move || {
            let prompt = format!(
                r#"[dispatcher classified this turn as: {category}]

== conversation log since last review ==
{conversation_log}

[full transcript slice (raw JSONL, anchor → end) available at: {slice_path}]
Read it only if you need verbatim quotes longer than what appears inline above, or tool_result content.

Analyze the last user message in the conversation log. If it is a correction worth recording, persist it to .haltr/memory/ as a new entry per your instructions, then return the structured JSON below.

Respond with pure JSON only (no markdown, no text before/after):
{{
  "wrote": true|false,
  "slug": "<slug>" | null,
  "reason": "<short explanation>"
}}"#,
                category = if category.is_empty() { "ambiguous" } else { &category },
                conversation_log = conversation_log,
                slice_path = slice_path,
            );
            invoke_claude(
                &format!("{}/memory-writer.md", agents_dir_m),
                &prompt,
                MEMORY_WRITER_BUDGET,
                None,
                &cwd_m,
            )
        }))
    } else {
        None
    };

    // Wait for results
    let critic_result = critic_handle.map(|h| h.join().unwrap_or_else(|_| Err(anyhow::anyhow!("thread panic"))));
    let memory_result = memory_handle.map(|h| h.join().unwrap_or_else(|_| Err(anyhow::anyhow!("thread panic"))));

    // Log memory result
    if let Some(ref mr) = memory_result {
        match mr {
            Ok(resp) => {
                match parse_memory_response(&resp.text) {
                    Ok(parsed) => {
                        let action = if parsed.wrote { "done" } else { "noop" };
                        append_log(&log_file, "memory", serde_json::json!({
                            "action": action,
                            "wrote": parsed.wrote,
                            "slug": parsed.slug,
                            "reason": parsed.reason,
                            "cost_usd": resp.cost,
                            "result": resp.text,
                            "session_id": resp.session_id,
                        }));
                    }
                    Err(e) => {
                        append_log(&log_file, "memory", serde_json::json!({
                            "action": "failed",
                            "error_kind": "parse_error",
                            "reason": format!("{}", e),
                            "cost_usd": resp.cost,
                            "result": resp.text,
                            "session_id": resp.session_id,
                        }));
                    }
                }
            }
            Err(e) => {
                append_log(&log_file, "memory", serde_json::json!({
                    "action": "failed",
                    "error_kind": "invoke_error",
                    "reason": format!("{}", e),
                }));
            }
        }
    }

    // Process critic verdict
    let exit_code = if let Some(cr) = critic_result {
        match cr {
            Ok(resp) => {
                let critic_sid = &resp.session_id;
                match parse_critic_response(&resp.text) {
                    Ok(panel) => {
                        let num_findings = panel.findings.len();
                        update_memory_stats_from_findings(&haltr_dir, &panel.findings, &log_file);
                        if panel.decision == "block" {
                            state.critic_iter += 1;
                            session::save(&session_id, &state).ok();

                            if state.critic_iter > MAX_ITER {
                                // Escalate
                                state.critic_iter = 0;
                                session::save(&session_id, &state).ok();
                                append_log(&log_file, "verdict", serde_json::json!({
                                    "decision": "escalate",
                                    "reason": panel.extra.get("reason").cloned().unwrap_or(Value::Null),
                                    "findings": panel.findings,
                                    "findings_count": num_findings,
                                    "iteration": state.critic_iter,
                                    "cost_usd": resp.cost,
                                    "critic_session_id": critic_sid,
                                    "total_duration_ms": t_start.elapsed().as_millis()
                                }));
                                let findings_json = serde_json::to_string_pretty(&panel.findings).unwrap_or_default();
                                eprintln!("[haltr] {} consecutive blocks, escalating. Findings:\n{}", MAX_ITER, findings_json);
                                0
                            } else {
                                append_log(&log_file, "verdict", serde_json::json!({
                                    "decision": "block",
                                    "reason": panel.extra.get("reason").cloned().unwrap_or(Value::Null),
                                    "findings": panel.findings,
                                    "findings_count": num_findings,
                                    "iteration": state.critic_iter,
                                    "cost_usd": resp.cost,
                                    "critic_session_id": critic_sid,
                                    "total_duration_ms": t_start.elapsed().as_millis()
                                }));
                                let decision_json = serde_json::json!({
                                    "decision": "block",
                                    "reason": panel.extra.get("reason").cloned().unwrap_or(Value::Null),
                                    "findings": panel.findings,
                                });
                                eprintln!("{}", serde_json::to_string(&decision_json).unwrap_or_default());
                                2
                            }
                        } else {
                            state.critic_iter = 0;
                            session::save(&session_id, &state).ok();
                            append_log(&log_file, "verdict", serde_json::json!({
                                "decision": "approve",
                                "reason": panel.extra.get("reason").cloned().unwrap_or(Value::Null),
                                "findings": panel.findings,
                                "findings_count": num_findings,
                                "cost_usd": resp.cost,
                                "critic_session_id": critic_sid,
                                "total_duration_ms": t_start.elapsed().as_millis()
                            }));
                            0
                        }
                    }
                    Err(e) => {
                        append_log(&log_file, "verdict", serde_json::json!({
                            "decision": "fail-open",
                            "reason": format!("parse error: {}", e),
                            "cost_usd": resp.cost,
                            "critic_session_id": critic_sid,
                            "total_duration_ms": t_start.elapsed().as_millis()
                        }));
                        0
                    }
                }
            }
            Err(e) => {
                append_log(&log_file, "verdict", serde_json::json!({
                    "decision": "fail-open",
                    "reason": format!("invoke error: {}", e),
                    "total_duration_ms": t_start.elapsed().as_millis()
                }));
                0
            }
        }
    } else {
        append_log(&log_file, "verdict", serde_json::json!({
            "decision": "skip-critic",
            "total_duration_ms": t_start.elapsed().as_millis()
        }));
        0
    };

    // Collect non-blocking warnings to surface via `systemMessage` on exit 0.
    // (Exit-2 paths above already returned via `std::process::exit`.)
    let mut warnings: Vec<String> = Vec::new();

    if memory_result.is_some() {
        if let Some(msg) = detect_consecutive_failure_warning(&log_file, "memory") {
            warnings.push(msg);
        }
    }

    let outdated = migrate::detect_outdated(&haltr_dir);
    if !outdated.is_empty() {
        warnings.push(format!(
            "[haltr] {} agent file(s) appear out of date: {}. Run `hal migrate hint` and apply the changes to bring them in line with this haltr binary's contracts.",
            outdated.len(),
            outdated.join(", "),
        ));
    }

    // Layer 2 ran — advance transcript position
    state.last_anchor_line = new_anchor;
    session::save(&session_id, &state).ok();

    transcript::cleanup_turn_slice(&log_dir, &session_id);

    if exit_code != 0 {
        std::process::exit(exit_code);
    }

    if !warnings.is_empty() {
        // Stop hook honors top-level `systemMessage` on exit 0 and shows it
        // to the user as a warning without blocking the stop. Per Claude Code
        // hooks reference (Universal JSON output fields).
        let out = serde_json::json!({ "systemMessage": warnings.join("\n") });
        println!("{}", out);
    }
    Ok(())
}

fn discover_critics(agents_dir: &str) -> Vec<CriticInfo> {
    let critics_dir = format!("{}/critics", agents_dir);
    let mut critics = Vec::new();

    let entries = match std::fs::read_dir(&critics_dir) {
        Ok(e) => e,
        Err(_) => return critics,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let name = path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let description = extract_first_heading(&content)
            .unwrap_or_else(|| name.clone());

        critics.push(CriticInfo { name, description, content });
    }

    critics.sort_by(|a, b| a.name.cmp(&b.name));
    critics
}

fn extract_first_heading(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            return Some(trimmed.trim_start_matches('#').trim().to_string());
        }
    }
    None
}

fn build_critic_catalog(critics: &[CriticInfo]) -> String {
    if critics.is_empty() {
        return "(no critics found in .haltr/agents/critics/)".to_string();
    }
    critics.iter()
        .map(|r| format!("- `{}`: {}", r.name, r.description))
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_selected_critic_defs(all: &[CriticInfo], selected: &[String]) -> String {
    selected.iter()
        .filter_map(|name| {
            all.iter().find(|r| r.name == *name)
        })
        .map(|r| format!("### Reviewer: {}\n\n{}", r.name, r.content))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

struct ClaudeResponse {
    text: String,
    cost: f64,
    session_id: String,
}

fn invoke_claude(system_prompt_file: &str, prompt: &str, budget: &str, model: Option<&str>, cwd: &str) -> Result<ClaudeResponse> {
    use std::io::Write;

    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg("--system-prompt-file")
        .arg(system_prompt_file)
        .arg("--output-format")
        .arg("json")
        .arg("--max-budget-usd")
        .arg(budget)
        .arg("--settings")
        .arg(r#"{"disableAllHooks":true}"#)
        .arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg(r#"{"mcpServers":{}}"#);

    if let Some(m) = model {
        cmd.arg("--model").arg(m);
    }

    let mut child = cmd
        .current_dir(cwd)
        .env("CLAUDE_HOOK_NESTED", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("failed to spawn claude")?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).ok();
    }

    let output = child.wait_with_output()
        .context("failed to wait for claude")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(anyhow::anyhow!("claude exited with {}: {}{}", output.status, stdout, stderr));
    }

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let json: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);

    let text = json.get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cost = json.get("total_cost_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let session_id = json.get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(ClaudeResponse { text, cost, session_id })
}

fn parse_dispatch_response(text: &str) -> Result<DispatcherResponse> {
    let cleaned = strip_markdown_fence(text);
    serde_json::from_str(&cleaned).context("failed to parse dispatcher response")
}

fn parse_critic_response(text: &str) -> Result<CriticPanelResponse> {
    let cleaned = strip_markdown_fence(text);
    serde_json::from_str(&cleaned).context("failed to parse critic panel response")
}

fn parse_memory_response(text: &str) -> Result<MemoryWriterResponse> {
    let cleaned = strip_markdown_fence(text);
    serde_json::from_str(&cleaned).context("failed to parse memory-writer response")
}

fn strip_markdown_fence(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.starts_with("```")
        })
        .collect::<Vec<_>>()
        .join("\n")
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
    let default = std::env::current_dir()?.join(".haltr");
    Ok(default.to_string_lossy().to_string())
}

/// Scan log file for the trailing run of consecutive failed entries for a
/// layer with the same `error_kind`. Returns a one-line warning message when
/// the run reaches the warn threshold; otherwise returns `None`.
fn detect_consecutive_failure_warning(log_file: &str, layer: &str) -> Option<String> {
    let content = std::fs::read_to_string(log_file).ok()?;

    let mut consecutive = 0usize;
    let mut error_kind: Option<String> = None;

    for line in content.lines().rev() {
        let entry: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if entry.get("layer").and_then(|v| v.as_str()) != Some(layer) {
            continue;
        }
        if entry.get("action").and_then(|v| v.as_str()) != Some("failed") {
            break;
        }
        let kind = entry.get("error_kind")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        match &error_kind {
            None => {
                error_kind = Some(kind);
                consecutive = 1;
            }
            Some(prev) if prev == &kind => {
                consecutive += 1;
            }
            _ => break,
        }
    }

    if consecutive >= CONSECUTIVE_FAILURE_WARN_THRESHOLD {
        let kind = error_kind.unwrap_or_else(|| "unknown".to_string());
        Some(format!(
            "[haltr] {}-layer has failed {} times in a row ({}). See {}",
            layer, consecutive, kind, log_file
        ))
    } else {
        None
    }
}

/// Walk a critic panel's findings and update `.haltr/memory/00_stats.json`
/// with each memory-feedback-reader run's `checked` / `matched` lists.
///
/// Failures are silent (logged to the session log file at most): stat
/// tracking is purely advisory and must never block the hook pipeline.
fn update_memory_stats_from_findings(haltr_dir: &str, findings: &[Value], log_file: &str) {
    let mut checked: Vec<String> = Vec::new();
    let mut matched: Vec<String> = Vec::new();

    for f in findings {
        let critic_name = f.get("critic").and_then(|v| v.as_str()).unwrap_or("");
        if critic_name != "memory-feedback-reader" {
            continue;
        }
        let detail = match f.get("detail").and_then(|v| v.as_str()) {
            Some(d) => d,
            None => continue,
        };
        if let Some((c, m)) = memory_stats::extract_haltr_stats(detail) {
            checked.extend(c);
            matched.extend(m);
        }
    }

    if checked.is_empty() && matched.is_empty() {
        return;
    }

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let path = memory_stats::stats_path(haltr_dir);
    if let Err(e) = memory_stats::record_run(&path, &checked, &matched, &now) {
        append_log(log_file, "memory_stats", serde_json::json!({
            "action": "failed",
            "error_kind": "stats_write_error",
            "reason": format!("{}", e),
        }));
    } else {
        append_log(log_file, "memory_stats", serde_json::json!({
            "action": "updated",
            "checked_count": checked.len(),
            "matched_count": matched.len(),
        }));
    }
}

fn append_log(log_file: &str, layer: &str, data: Value) {
    let entry = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "layer": layer,
    });

    let mut map = match entry {
        Value::Object(m) => m,
        _ => return,
    };
    if let Value::Object(d) = data {
        map.extend(d);
    }

    if let Ok(line) = serde_json::to_string(&Value::Object(map)) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_file) {
            let _ = writeln!(f, "{}", line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_memory_response_wrote_true() {
        let text = r#"{"wrote": true, "slug": "hook-exit-2", "reason": "user corrected exit code usage"}"#;
        let parsed = parse_memory_response(text).expect("should parse");
        assert!(parsed.wrote);
        assert_eq!(parsed.slug.as_deref(), Some("hook-exit-2"));
        assert_eq!(parsed.reason.as_deref(), Some("user corrected exit code usage"));
    }

    #[test]
    fn parse_memory_response_wrote_false_with_null_slug() {
        let text = r#"{"wrote": false, "slug": null, "reason": "no correction in last turn"}"#;
        let parsed = parse_memory_response(text).expect("should parse");
        assert!(!parsed.wrote);
        assert!(parsed.slug.is_none());
        assert_eq!(parsed.reason.as_deref(), Some("no correction in last turn"));
    }

    #[test]
    fn parse_memory_response_strips_markdown_fence() {
        let text = "```json\n{\"wrote\": true, \"slug\": \"x\", \"reason\": \"y\"}\n```";
        let parsed = parse_memory_response(text).expect("should parse");
        assert!(parsed.wrote);
        assert_eq!(parsed.slug.as_deref(), Some("x"));
    }

    #[test]
    fn parse_memory_response_invalid_json_errors() {
        let text = "not json at all";
        assert!(parse_memory_response(text).is_err());
    }

    fn temp_log_file(name: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir()
            .join(format!("haltr-stop-test-{}-{}-{}.jsonl", std::process::id(), id, name));
        let _ = std::fs::remove_file(&path);
        path.to_string_lossy().to_string()
    }

    fn write_entry(log: &str, layer: &str, action: &str, error_kind: Option<&str>) {
        let mut entry = serde_json::json!({"layer": layer, "action": action});
        if let Some(k) = error_kind {
            entry["error_kind"] = serde_json::Value::String(k.to_string());
        }
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .unwrap();
        writeln!(f, "{}", entry).unwrap();
    }

    #[test]
    fn warn_when_threshold_consecutive_same_kind() {
        let log = temp_log_file("warn-threshold");
        for _ in 0..3 {
            write_entry(&log, "memory", "failed", Some("parse_error"));
        }
        let msg = detect_consecutive_failure_warning(&log, "memory").expect("should warn");
        assert!(msg.contains("memory-layer"));
        assert!(msg.contains("3 times"));
        assert!(msg.contains("parse_error"));
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn no_warn_when_run_broken_by_success() {
        let log = temp_log_file("no-warn-success");
        write_entry(&log, "memory", "failed", Some("parse_error"));
        write_entry(&log, "memory", "failed", Some("parse_error"));
        write_entry(&log, "memory", "done", None); // breaks the run
        write_entry(&log, "memory", "failed", Some("parse_error"));
        // Trailing run of failed entries is only 1, below threshold.
        assert!(detect_consecutive_failure_warning(&log, "memory").is_none());
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn no_warn_when_run_broken_by_different_kind() {
        let log = temp_log_file("no-warn-mixed");
        write_entry(&log, "memory", "failed", Some("invoke_error"));
        write_entry(&log, "memory", "failed", Some("parse_error"));
        write_entry(&log, "memory", "failed", Some("parse_error"));
        // Trailing run of "parse_error" is 2, below threshold.
        assert!(detect_consecutive_failure_warning(&log, "memory").is_none());
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn ignores_other_layers() {
        let log = temp_log_file("ignores-other");
        write_entry(&log, "dispatcher", "failed", Some("parse_error"));
        write_entry(&log, "memory", "failed", Some("parse_error"));
        write_entry(&log, "verdict", "failed", Some("parse_error"));
        write_entry(&log, "memory", "failed", Some("parse_error"));
        write_entry(&log, "memory", "failed", Some("parse_error"));
        // memory-layer trailing run = 3 (other layers should be skipped, not break the run)
        let msg = detect_consecutive_failure_warning(&log, "memory").expect("should warn");
        assert!(msg.contains("3 times"));
        let _ = std::fs::remove_file(&log);
    }
}
