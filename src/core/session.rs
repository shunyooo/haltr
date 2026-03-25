use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

/// Get the global sessions directory (~/.haltr/sessions/).
fn sessions_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Could not determine home directory")?;
    Ok(home.join(".haltr").join("sessions"))
}

/// Get the current session ID from HALTR_SESSION_ID env var.
pub fn get_session_id() -> Result<String> {
    std::env::var("HALTR_SESSION_ID")
        .map_err(|_| anyhow::anyhow!("HALTR_SESSION_ID is not set. Run hal setup first"))
}

/// Save session_id -> task path mapping.
pub fn set_session_task(session_id: &str, task_path: &str) -> Result<()> {
    let dir = sessions_dir()?;
    fs::create_dir_all(&dir)?;
    let session_file = dir.join(session_id);
    fs::write(&session_file, task_path)?;
    Ok(())
}

/// Get task path for a given session ID. Returns None if no mapping exists.
pub fn get_task_path_for_session(session_id: &str) -> Option<String> {
    let dir = sessions_dir().ok()?;
    let session_file = dir.join(session_id);
    if !session_file.exists() {
        return None;
    }
    let content = fs::read_to_string(&session_file).ok()?;
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn test_get_session_id_not_set() {
        let _lock = ENV_LOCK.lock().unwrap();
        let saved = env::var("HALTR_SESSION_ID").ok();
        env::remove_var("HALTR_SESSION_ID");
        let result = get_session_id();
        assert!(result.is_err());
        if let Some(v) = saved {
            env::set_var("HALTR_SESSION_ID", v);
        }
    }

    #[test]
    fn test_get_session_id_set() {
        let _lock = ENV_LOCK.lock().unwrap();
        let saved = env::var("HALTR_SESSION_ID").ok();
        env::set_var("HALTR_SESSION_ID", "test-session-123");
        let result = get_session_id().unwrap();
        assert_eq!(result, "test-session-123");
        match saved {
            Some(v) => env::set_var("HALTR_SESSION_ID", v),
            None => env::remove_var("HALTR_SESSION_ID"),
        }
    }

    #[test]
    fn test_set_and_get_task_path() {
        let session_id = format!("test-session-{}", std::process::id());
        let task_path = "/tmp/test-task.yaml";

        set_session_task(&session_id, task_path).unwrap();
        let result = get_task_path_for_session(&session_id);
        assert_eq!(result, Some(task_path.to_string()));

        // Cleanup
        let dir = sessions_dir().unwrap();
        let _ = fs::remove_file(dir.join(&session_id));
    }

    #[test]
    fn test_get_task_path_nonexistent() {
        let result = get_task_path_for_session("nonexistent-session-xyz");
        assert_eq!(result, None);
    }
}
