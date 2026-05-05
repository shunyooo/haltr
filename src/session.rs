use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub critic_enabled: bool,
    #[serde(default)]
    pub critic_iter: u32,
    #[serde(default)]
    pub last_anchor_line: usize,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            critic_enabled: true,
            critic_iter: 0,
            last_anchor_line: 0,
        }
    }
}

fn state_path(session_id: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/haltr-{}.json", session_id))
}

fn global_kill_switch_path() -> PathBuf {
    PathBuf::from("/tmp/haltr-disabled")
}

pub fn load(session_id: &str) -> SessionState {
    let path = state_path(session_id);
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => SessionState::default(),
    }
}

pub fn save(session_id: &str, state: &SessionState) -> Result<()> {
    let path = state_path(session_id);
    let json = serde_json::to_string_pretty(state)?;
    std::fs::write(&path, json).context("failed to write session state")?;
    Ok(())
}

pub fn is_globally_disabled() -> bool {
    global_kill_switch_path().exists()
}

pub fn set_global_kill_switch(disabled: bool) -> Result<()> {
    let path = global_kill_switch_path();
    if disabled {
        std::fs::write(&path, "").context("failed to create global kill switch")?;
    } else if path.exists() {
        std::fs::remove_file(&path).context("failed to remove global kill switch")?;
    }
    Ok(())
}

pub fn get_session_id() -> Option<String> {
    std::env::var("HALTR_SESSION_ID")
        .ok()
        .or_else(|| std::env::var("CLAUDE_SESSION_ID").ok())
}
