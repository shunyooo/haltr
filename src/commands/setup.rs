use anyhow::{Context, Result};
use std::fs;

pub fn handle_setup() -> Result<()> {
    let home = dirs::home_dir().context("Could not determine home directory")?;
    let settings_path = home.join(".claude").join("settings.json");

    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .context("Failed to read ~/.claude/settings.json")?;
        serde_json::from_str(&content)
            .context("Failed to parse ~/.claude/settings.json")?
    } else {
        serde_json::json!({})
    };

    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    // SessionStart hook — structure: [{ "hooks": [{ "type": "command", "command": "..." }] }]
    let session_start = hooks
        .as_object_mut()
        .unwrap()
        .entry("SessionStart")
        .or_insert_with(|| serde_json::json!([]));
    let session_start_arr = session_start.as_array().unwrap();
    let has_session_start = session_start_arr.iter().any(|group| {
        group.get("hooks")
            .and_then(|h| h.as_array())
            .map(|hooks| hooks.iter().any(|h| h.get("command").and_then(|v| v.as_str()) == Some("hal session-start")))
            .unwrap_or(false)
    });
    if !has_session_start {
        session_start.as_array_mut().unwrap().push(serde_json::json!({
            "hooks": [{ "type": "command", "command": "hal session-start" }]
        }));
    }

    // Stop hook
    let stop = hooks
        .as_object_mut()
        .unwrap()
        .entry("Stop")
        .or_insert_with(|| serde_json::json!([]));
    let stop_arr = stop.as_array().unwrap();
    let has_stop = stop_arr.iter().any(|group| {
        group.get("hooks")
            .and_then(|h| h.as_array())
            .map(|hooks| hooks.iter().any(|h| h.get("command").and_then(|v| v.as_str()) == Some("hal check")))
            .unwrap_or(false)
    });
    if !has_stop {
        stop.as_array_mut().unwrap().push(serde_json::json!({
            "hooks": [{ "type": "command", "command": "hal check" }]
        }));
    }

    // Ensure directory exists
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let content = serde_json::to_string_pretty(&settings)?;
    fs::write(&settings_path, format!("{}\n", content))?;

    println!("haltr hooks configured:");
    println!("  - SessionStart: hal session-start");
    println!("  - Stop: hal check");
    println!("  - Settings: {}", settings_path.display());
    Ok(())
}
