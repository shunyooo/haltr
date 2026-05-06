use anyhow::{Context, Result};
use serde_json::Value;

pub struct TurnSlice {
    /// Chronological conversation log since anchor (for dispatcher)
    pub conversation_log: String,
    /// Write tool count in the LAST turn only (for Layer 0b gate)
    pub last_turn_write_count: usize,
    /// Tool count in the LAST turn only
    pub last_turn_tool_count: usize,
    /// Total tool count since anchor (for logging)
    pub tool_count: usize,
    /// Write tool count since anchor (for logging)
    pub write_tool_count: usize,
    /// Path to the full slice file (anchor → end, for Layer 2 agents)
    pub slice_path: String,
    /// Total transcript lines (for anchor update)
    pub total_lines: usize,
}

pub fn extract_turn_slice(
    transcript_path: &str,
    log_dir: &str,
    session_id: &str,
    last_checked_lines: usize,
) -> Result<Option<TurnSlice>> {
    let content = std::fs::read_to_string(transcript_path)
        .context("failed to read transcript")?;

    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    if total_lines == 0 || total_lines <= last_checked_lines {
        return Ok(None);
    }

    let slice_lines: Vec<&str> = lines[last_checked_lines..].to_vec();

    // Find the last real user message position within the slice (for Layer 0b)
    let mut last_user_pos = None;
    for (i, line) in slice_lines.iter().enumerate() {
        if let Ok(entry) = serde_json::from_str::<Value>(line) {
            if entry.get("type").and_then(|t| t.as_str()) == Some("user") {
                if let Some(content) = entry.pointer("/message/content") {
                    if content.is_string() {
                        last_user_pos = Some(i);
                    }
                }
            }
        }
    }

    // Build conversation log and collect tool stats
    let mut conversation_parts: Vec<String> = Vec::new();
    let mut has_user_message = false;
    let mut total_tool_count = 0usize;
    let mut total_write_count = 0usize;
    let mut last_turn_tool_count = 0usize;
    let mut last_turn_write_count = 0usize;

    for (i, line) in slice_lines.iter().enumerate() {
        if let Ok(entry) = serde_json::from_str::<Value>(line) {
            let is_last_turn = last_user_pos.map(|p| i >= p).unwrap_or(true);

            match entry.get("type").and_then(|t| t.as_str()) {
                Some("user") => {
                    if let Some(content) = entry.pointer("/message/content") {
                        if let Some(text) = content.as_str() {
                            has_user_message = true;
                            let truncated: String = text.chars().take(2000).collect();
                            conversation_parts.push(format!("[user] {}", truncated));
                        }
                    }
                }
                Some("assistant") => {
                    if let Some(contents) = entry.pointer("/message/content").and_then(|c| c.as_array()) {
                        let mut text_parts: Vec<String> = Vec::new();
                        let mut tool_parts: Vec<String> = Vec::new();

                        for block in contents {
                            match block.get("type").and_then(|t| t.as_str()) {
                                Some("text") => {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        let truncated: String = text.chars().take(500).collect();
                                        text_parts.push(truncated);
                                    }
                                }
                                Some("tool_use") => {
                                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                                    let detail = extract_tool_detail(block);
                                    let summary = if detail.is_empty() {
                                        format!("  - {}", name)
                                    } else {
                                        format!("  - {}: {}", name, detail)
                                    };
                                    tool_parts.push(summary);

                                    let is_write = matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit");
                                    total_tool_count += 1;
                                    if is_write {
                                        total_write_count += 1;
                                    }
                                    if is_last_turn {
                                        last_turn_tool_count += 1;
                                        if is_write {
                                            last_turn_write_count += 1;
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }

                        let mut assistant_entry = String::from("[assistant] ");
                        if !text_parts.is_empty() {
                            assistant_entry.push_str(&text_parts.join(" "));
                        }
                        if !tool_parts.is_empty() {
                            assistant_entry.push('\n');
                            assistant_entry.push_str(&tool_parts.join("\n"));
                        }
                        conversation_parts.push(assistant_entry);
                    }
                }
                _ => {}
            }
        }
    }

    if !has_user_message {
        return Ok(None);
    }

    // Write full slice for Layer 2 agents
    let slice_content = slice_lines.join("\n");
    let slice_path = format!("{}/turn-slice-{}.jsonl", log_dir, session_id);
    std::fs::write(&slice_path, &slice_content)
        .context("failed to write turn slice")?;

    // Truncate conversation log to avoid oversized prompts
    let conversation_log = truncate_conversation_log(&conversation_parts, 15000);

    Ok(Some(TurnSlice {
        conversation_log,
        last_turn_write_count,
        last_turn_tool_count,
        write_tool_count: total_write_count,
        tool_count: total_tool_count,
        slice_path,
        total_lines,
    }))
}

fn truncate_conversation_log(parts: &[String], max_chars: usize) -> String {
    let full = parts.join("\n");
    if full.len() <= max_chars {
        return full;
    }
    // Keep the end (most recent conversation is most important)
    let truncated: String = full.chars().rev().take(max_chars).collect::<String>().chars().rev().collect();
    format!("...(truncated)\n{}", truncated)
}

fn extract_tool_detail(block: &Value) -> String {
    if let Some(input) = block.get("input") {
        if let Some(fp) = input.get("file_path").and_then(|v| v.as_str()) {
            return fp.to_string();
        }
        if let Some(cmd) = input.get("command").and_then(|v| v.as_str()) {
            return cmd.chars().take(80).collect();
        }
        if let Some(pat) = input.get("pattern").and_then(|v| v.as_str()) {
            return pat.chars().take(80).collect();
        }
    }
    String::new()
}

pub fn cleanup_turn_slice(log_dir: &str, session_id: &str) {
    let path = format!("{}/turn-slice-{}.jsonl", log_dir, session_id);
    let _ = std::fs::remove_file(path);
}
