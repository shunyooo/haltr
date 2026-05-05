use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::process::Command;

use crate::session;
use crate::transcript;

const MAX_ITER: u32 = 2;
const DISPATCHER_BUDGET: &str = "0.10";
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
    if !state.critic_enabled {
        return Ok(());
    }

    // Ensure log directory exists
    let haltr_dir = find_haltr_dir()?;
    let log_dir = format!("{}/logs", haltr_dir);
    std::fs::create_dir_all(&log_dir).ok();
    let log_file = format!("{}/{}.jsonl", log_dir, session_id);

    let t_start = std::time::Instant::now();

    // Layer 0b: transcript analysis (slice from last checked position)
    let turn = match transcript::extract_turn_slice(&transcript_path, &log_dir, &session_id, state.last_transcript_lines)? {
        Some(t) => t,
        None => {
            append_log(&log_file, "0b", serde_json::json!({"action": "skip", "reason": "no new content since last check"}));
            return Ok(());
        }
    };

    // Update transcript position for next invocation
    state.last_transcript_lines = turn.total_lines;
    session::save(&session_id, &state).ok();

    if turn.write_tool_count == 0 {
        append_log(&log_file, "0b", serde_json::json!({
            "action": "skip",
            "reason": "no write tools",
            "tools": turn.tool_count
        }));
        transcript::cleanup_turn_slice(&log_dir, &session_id);
        return Ok(());
    }

    append_log(&log_file, "0b", serde_json::json!({
        "action": "pass",
        "tools": turn.tool_count,
        "write_tools": turn.write_tool_count
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

== Last user message ==
{user_text}

== Last assistant response (first 3000 chars) ==
{assistant_text}

== Tool calls in this turn (up to 30) ==
{tool_summary}

== git status ==
{git_status}

Respond with pure JSON only (no markdown, no text before/after):
{{
  "critic": {{ "run": true|false, "critics": ["<name>", ...] }},
  "memory": {{ "run": true|false, "category": "strong-correction"|"soft-redirect"|"noise"|"ambiguous" }},
  "reason": "..."
}}

Only select reviewer names from the available critics list above."#,
        critic_catalog = critic_catalog,
        user_text = turn.user_text,
        assistant_text = turn.assistant_text,
        tool_summary = turn.tool_summary,
        git_status = git_status,
    );

    let t_dispatch = std::time::Instant::now();
    let dispatch_result = invoke_claude(
        &format!("{}/dispatcher.md", agents_dir),
        &dispatcher_prompt,
        DISPATCHER_BUDGET,
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
                        "memory_run": d.memory.as_ref().map(|m| m.run).unwrap_or(false),
                        "cost_usd": cost,
                        "duration_ms": dispatch_duration
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
  "findings": [{{"reviewer":"...", "severity":"red"|"yellow", "title":"...", "detail":"<verbatim>"}}],
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
            )
        }))
    } else {
        None
    };

    let memory_handle = if run_memory {
        let agents_dir_m = agents_dir.clone();
        let transcript_path_m = transcript_path.clone();
        Some(std::thread::spawn(move || {
            let prompt = format!(
                "Transcript path: {}\n\nAnalyze the last turn. If the user made a correction, persist it to .haltr/memory/ as a new entry.",
                transcript_path_m
            );
            invoke_claude(
                &format!("{}/memory-writer.md", agents_dir_m),
                &prompt,
                MEMORY_WRITER_BUDGET,
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
                append_log(&log_file, "memory", serde_json::json!({
                    "action": "done",
                    "cost_usd": resp.cost,
                }));
            }
            Err(e) => {
                append_log(&log_file, "memory", serde_json::json!({
                    "action": "error",
                    "reason": format!("{}", e),
                }));
            }
        }
    }

    // Process critic verdict
    let exit_code = if let Some(cr) = critic_result {
        match cr {
            Ok(resp) => {
                match parse_critic_response(&resp.text) {
                    Ok(panel) => {
                        let num_findings = panel.findings.len();
                        if panel.decision == "block" {
                            state.critic_iter += 1;
                            session::save(&session_id, &state).ok();

                            if state.critic_iter > MAX_ITER {
                                // Escalate
                                state.critic_iter = 0;
                                session::save(&session_id, &state).ok();
                                append_log(&log_file, "verdict", serde_json::json!({
                                    "decision": "escalate",
                                    "findings": num_findings,
                                    "iteration": state.critic_iter,
                                    "cost_usd": resp.cost,
                                    "total_duration_ms": t_start.elapsed().as_millis()
                                }));
                                let findings_json = serde_json::to_string_pretty(&panel.findings).unwrap_or_default();
                                eprintln!("[haltr] {} consecutive blocks, escalating. Findings:\n{}", MAX_ITER, findings_json);
                                0
                            } else {
                                append_log(&log_file, "verdict", serde_json::json!({
                                    "decision": "block",
                                    "findings": num_findings,
                                    "iteration": state.critic_iter,
                                    "cost_usd": resp.cost,
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
                                "findings": num_findings,
                                "cost_usd": resp.cost,
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

    transcript::cleanup_turn_slice(&log_dir, &session_id);

    if exit_code != 0 {
        std::process::exit(exit_code);
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
}

fn invoke_claude(system_prompt_file: &str, prompt: &str, budget: &str) -> Result<ClaudeResponse> {
    use std::io::Write;

    let mut child = Command::new("claude")
        .arg("-p")
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
        .arg(r#"{"mcpServers":{}}"#)
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

    Ok(ClaudeResponse { text, cost })
}

fn parse_dispatch_response(text: &str) -> Result<DispatcherResponse> {
    let cleaned = strip_markdown_fence(text);
    serde_json::from_str(&cleaned).context("failed to parse dispatcher response")
}

fn parse_critic_response(text: &str) -> Result<CriticPanelResponse> {
    let cleaned = strip_markdown_fence(text);
    serde_json::from_str(&cleaned).context("failed to parse critic panel response")
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
