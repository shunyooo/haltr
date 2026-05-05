use anyhow::{Context, Result};
use serde_json::Value;

pub struct TurnSlice {
    pub user_text: String,
    pub assistant_text: String,
    pub tool_summary: String,
    pub write_tool_count: usize,
    pub tool_count: usize,
    pub slice_path: String,
}

pub fn extract_turn_slice(transcript_path: &str, log_dir: &str, session_id: &str) -> Result<Option<TurnSlice>> {
    let content = std::fs::read_to_string(transcript_path)
        .context("failed to read transcript")?;

    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return Ok(None);
    }

    // Find last real user message (not tool_result)
    let mut last_user_lineno = None;
    for (i, line) in lines.iter().enumerate() {
        if let Ok(entry) = serde_json::from_str::<Value>(line) {
            if entry.get("type").and_then(|t| t.as_str()) == Some("user") {
                // Filter out tool_result entries: real user input has content as string
                if let Some(content) = entry.pointer("/message/content") {
                    if content.is_string() {
                        last_user_lineno = Some(i);
                    }
                }
            }
        }
    }

    let last_user_lineno = match last_user_lineno {
        Some(n) => n,
        None => return Ok(None),
    };

    // Write turn slice to temp file for Layer 2 agents to read
    let slice_lines: Vec<&str> = lines[last_user_lineno..].to_vec();
    let slice_content = slice_lines.join("\n");

    let slice_path = format!("{}/turn-slice-{}.jsonl", log_dir, session_id);
    std::fs::write(&slice_path, &slice_content)
        .context("failed to write turn slice")?;

    // Extract user text
    let user_text = if let Ok(entry) = serde_json::from_str::<Value>(lines[last_user_lineno]) {
        entry.pointer("/message/content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .chars()
            .take(3000)
            .collect::<String>()
    } else {
        String::new()
    };

    // Extract assistant text and tool calls from the turn
    let mut assistant_text = String::new();
    let mut tool_lines: Vec<String> = Vec::new();
    let mut write_tool_count = 0usize;

    for line in &slice_lines[1..] {
        if let Ok(entry) = serde_json::from_str::<Value>(line) {
            if entry.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            if let Some(contents) = entry.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in contents {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                assistant_text.push_str(text);
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                            let detail = extract_tool_detail(block);
                            let summary = if detail.is_empty() {
                                format!("- {}", name)
                            } else {
                                format!("- {}: {}", name, detail)
                            };
                            tool_lines.push(summary);

                            if matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
                                write_tool_count += 1;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    // Truncate assistant text
    let assistant_text: String = assistant_text.chars().take(3000).collect();
    let tool_count = tool_lines.len();
    let tool_summary = tool_lines.into_iter().take(30).collect::<Vec<_>>().join("\n");

    Ok(Some(TurnSlice {
        user_text,
        assistant_text,
        tool_summary,
        write_tool_count,
        tool_count,
        slice_path,
    }))
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
