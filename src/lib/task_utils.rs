use anyhow::{Context, Result, bail};
use std::fs;
use std::path::{Path, PathBuf};

use crate::lib::session::get_task_path_for_session;

/// Resolve the task file path using a 3-level fallback:
/// 1. Explicit --file option
/// 2. Session mapping (HALTR_SESSION_ID -> ~/.haltr/sessions/)
/// 3. Auto-detect from current directory (task.yaml or *.task.yaml)
pub fn resolve_task_file(file: Option<&str>) -> Result<PathBuf> {
    // 1. Explicit --file
    if let Some(f) = file {
        let path = PathBuf::from(f).canonicalize().unwrap_or_else(|_| PathBuf::from(f));
        if !path.exists() {
            bail!("Task file not found: {}", path.display());
        }
        return Ok(path);
    }

    // 2. Session mapping
    if let Ok(session_id) = std::env::var("HALTR_SESSION_ID") {
        if let Some(mapped) = get_task_path_for_session(&session_id) {
            let path = PathBuf::from(&mapped);
            if path.exists() {
                return Ok(path);
            }
        }
    }

    // 3. Auto-detect from current directory
    if let Some(detected) = detect_task_file(&std::env::current_dir()?) {
        return Ok(detected);
    }

    bail!("Task file not found. Specify with --file")
}

/// Detect a task file in the given directory.
fn detect_task_file(dir: &Path) -> Option<PathBuf> {
    // Check for task.yaml
    let task_yaml = dir.join("task.yaml");
    if task_yaml.exists() {
        return Some(task_yaml);
    }

    // Check for *.task.yaml
    let entries = fs::read_dir(dir).ok()?;
    let task_files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(".task.yaml"))
                .unwrap_or(false)
        })
        .collect();

    match task_files.len() {
        1 => Some(task_files.into_iter().next().unwrap()),
        n if n > 1 => None, // Multiple files, ambiguous
        _ => None,
    }
}

/// Validate a status transition.
pub fn validate_status_transition(current: &str, new: &str) -> Result<()> {
    let valid = ["pending", "in_progress", "done", "failed"];
    if !valid.contains(&new) {
        bail!("Invalid status: \"{}\"", new);
    }

    let current = if current.is_empty() { "pending" } else { current };

    let allowed: &[&str] = match current {
        "pending" => &["in_progress"],
        "in_progress" => &["done", "failed"],
        "done" => &[],
        "failed" => &["in_progress"],
        _ => bail!("Invalid current status: \"{}\"", current),
    };

    if !allowed.contains(&new) {
        bail!("Invalid status transition: {} -> {}", current, new);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_resolve_explicit_file() {
        let tmp = std::env::temp_dir().join("haltr-test-resolve.yaml");
        fs::write(&tmp, "id: test\ngoal: test\n").unwrap();
        let result = resolve_task_file(Some(tmp.to_str().unwrap())).unwrap();
        assert!(result.exists());
        fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn test_resolve_nonexistent_file() {
        let result = resolve_task_file(Some("/tmp/nonexistent-haltr-xyz.yaml"));
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_transition_valid() {
        assert!(validate_status_transition("pending", "in_progress").is_ok());
        assert!(validate_status_transition("in_progress", "done").is_ok());
        assert!(validate_status_transition("in_progress", "failed").is_ok());
        assert!(validate_status_transition("failed", "in_progress").is_ok());
    }

    #[test]
    fn test_validate_transition_invalid() {
        assert!(validate_status_transition("pending", "done").is_err());
        assert!(validate_status_transition("done", "in_progress").is_err());
        assert!(validate_status_transition("pending", "failed").is_err());
    }

    #[test]
    fn test_validate_transition_invalid_status() {
        assert!(validate_status_transition("pending", "blocked").is_err());
    }
}
