use anyhow::{Context, Result};
use serde_json::Value;
use std::path::Path;

pub fn run() -> Result<()> {
    let project_root = std::env::current_dir()?;
    let haltr_dir = project_root.join(".haltr");

    // Create directory structure
    for dir in &["agents", "agents/reviewers", "memory", "logs"] {
        std::fs::create_dir_all(haltr_dir.join(dir))
            .with_context(|| format!("failed to create .haltr/{}", dir))?;
    }

    // Write agent definitions (skip if already exists — user may have customized)
    write_if_missing(&haltr_dir, "agents/dispatcher.md", include_str!("../agents/dispatcher.md"))?;
    write_if_missing(&haltr_dir, "agents/critic-orchestrator.md", include_str!("../agents/critic-orchestrator.md"))?;
    write_if_missing(&haltr_dir, "agents/memory-writer.md", include_str!("../agents/memory-writer.md"))?;

    // Write default reviewer definitions
    write_if_missing(&haltr_dir, "agents/reviewers/memory-feedback-reader.md", include_str!("../agents/reviewers/memory-feedback-reader.md"))?;
    write_if_missing(&haltr_dir, "agents/reviewers/expert-skeptic.md", include_str!("../agents/reviewers/expert-skeptic.md"))?;
    write_if_missing(&haltr_dir, "agents/reviewers/guard-l1.md", include_str!("../agents/reviewers/guard-l1.md"))?;
    write_if_missing(&haltr_dir, "agents/reviewers/guard-l2.md", include_str!("../agents/reviewers/guard-l2.md"))?;
    write_if_missing(&haltr_dir, "agents/reviewers/guard-l3.md", include_str!("../agents/reviewers/guard-l3.md"))?;

    // Initialize memory INDEX if not exists
    write_if_missing(&haltr_dir, "memory/INDEX.md", MEMORY_INDEX_TEMPLATE)?;

    // Register Stop hook in .claude/settings.json
    register_hook(&project_root)?;

    eprintln!("haltr setup complete:");
    eprintln!("  .haltr/agents/            — infrastructure agents (3 files)");
    eprintln!("  .haltr/agents/reviewers/  — reviewer agents (5 defaults, editable)");
    eprintln!("  .haltr/memory/            — learning pipeline memory");
    eprintln!("  .haltr/logs/              — hook execution logs");
    eprintln!("  .claude/settings.json     — Stop hook registered");

    Ok(())
}

fn write_if_missing(haltr_dir: &Path, rel_path: &str, content: &str) -> Result<()> {
    let path = haltr_dir.join(rel_path);
    if !path.exists() {
        std::fs::write(&path, content)
            .with_context(|| format!("failed to write {}", rel_path))?;
    }
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
