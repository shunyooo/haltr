use anyhow::{Context, Result};
use serde_json::Value;
use std::path::Path;

pub fn run() -> Result<()> {
    let project_root = std::env::current_dir()?;
    let haltr_dir = project_root.join(".haltr");

    // Create directory structure
    for dir in &["agents", "memory", "logs"] {
        std::fs::create_dir_all(haltr_dir.join(dir))
            .with_context(|| format!("failed to create .haltr/{}", dir))?;
    }

    // Write agent definitions
    write_agent_file(&haltr_dir, "dispatcher.md", include_str!("../agents/dispatcher.md"))?;
    write_agent_file(&haltr_dir, "critic-panel.md", include_str!("../agents/critic-panel.md"))?;
    write_agent_file(&haltr_dir, "memory-feedback-reader.md", include_str!("../agents/memory-feedback-reader.md"))?;
    write_agent_file(&haltr_dir, "memory-writer.md", include_str!("../agents/memory-writer.md"))?;

    // Initialize memory INDEX if not exists
    let index_path = haltr_dir.join("memory/INDEX.md");
    if !index_path.exists() {
        std::fs::write(&index_path, MEMORY_INDEX_TEMPLATE)
            .context("failed to write memory/INDEX.md")?;
    }

    // Register Stop hook in .claude/settings.json
    register_hook(&project_root)?;

    eprintln!("haltr setup complete:");
    eprintln!("  .haltr/agents/     — agent definitions (4 files)");
    eprintln!("  .haltr/memory/     — learning pipeline memory");
    eprintln!("  .haltr/logs/       — hook execution logs");
    eprintln!("  .claude/settings.json — Stop hook registered");

    Ok(())
}

fn write_agent_file(haltr_dir: &Path, name: &str, content: &str) -> Result<()> {
    let path = haltr_dir.join("agents").join(name);
    std::fs::write(&path, content)
        .with_context(|| format!("failed to write agents/{}", name))?;
    Ok(())
}

fn register_hook(project_root: &Path) -> Result<()> {
    let claude_dir = project_root.join(".claude");
    std::fs::create_dir_all(&claude_dir)?;

    let settings_path = claude_dir.join("settings.json");
    let mut settings: Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let hook_command = "hal hook stop";

    // Check if already registered
    if let Some(stop_hooks) = settings.pointer("/hooks/Stop") {
        if let Some(arr) = stop_hooks.as_array() {
            for entry in arr {
                if let Some(hooks) = entry.get("hooks").and_then(|h| h.as_array()) {
                    for hook in hooks {
                        if hook.get("command").and_then(|c| c.as_str()) == Some(hook_command) {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    // Add Stop hook
    let hook_entry = serde_json::json!([
        {
            "hooks": [{
                "type": "command",
                "command": hook_command,
                "timeout": 300
            }]
        }
    ]);

    let obj = settings.as_object_mut().context("settings is not an object")?;
    let hooks = obj.entry("hooks").or_insert(serde_json::json!({}));
    let hooks_obj = hooks.as_object_mut().context("hooks is not an object")?;
    hooks_obj.insert("Stop".to_string(), hook_entry);

    let formatted = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&settings_path, formatted)
        .context("failed to write .claude/settings.json")?;

    Ok(())
}

const MEMORY_INDEX_TEMPLATE: &str = r#"# haltr Memory — INDEX

Structured entries of user corrections and learned patterns.
**Read by**: memory-feedback-reader (critic pipeline)
**Written by**: memory-writer (learning pipeline)

## Entries
"#;
