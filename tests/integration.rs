use std::fs;
use std::process::Command;

fn hal(args: &[&str], cwd: &str) -> (String, i32) {
    hal_with_session(args, cwd, "integration-test")
}

fn hal_with_session(args: &[&str], cwd: &str, session_id: &str) -> (String, i32) {
    let output = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(args)
        .current_dir(cwd)
        .env("HALTR_SESSION_ID", session_id)
        .output()
        .expect("Failed to run hal");

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{}{}", stdout, stderr);
    (combined, output.status.code().unwrap_or(1))
}

fn setup_tmpdir() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("haltr-int-{}-{}", std::process::id(), id));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.to_str().unwrap().to_string()
}

fn cleanup(dir: &str) {
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_help() {
    let (output, code) = hal(&["--help"], ".");
    assert_eq!(code, 0);
    assert!(output.contains("haltr"));
    assert!(output.contains("What is haltr?"));
    assert!(output.contains("Workflow"));
}

#[test]
fn test_task_create_and_status() {
    let dir = setup_tmpdir();
    let task_file = format!("{}/test.yaml", dir);

    let (output, code) = hal(&["task", "create", "--file", &task_file, "--goal", "Test goal"], &dir);
    assert_eq!(code, 0, "task create failed: {}", output);
    assert!(output.contains("Task created"));

    let (output, code) = hal(&["status", "--file", &task_file], &dir);
    assert_eq!(code, 0, "status failed: {}", output);
    assert!(output.contains("Test goal"));
    assert!(output.contains("pending"));

    cleanup(&dir);
}

#[test]
fn test_task_create_duplicate_error() {
    let dir = setup_tmpdir();
    let task_file = format!("{}/dup.yaml", dir);

    hal(&["task", "create", "--file", &task_file, "--goal", "First"], &dir);
    let (output, code) = hal(&["task", "create", "--file", &task_file, "--goal", "Second"], &dir);
    assert_ne!(code, 0);
    assert!(output.contains("already exists"));

    cleanup(&dir);
}

#[test]
fn test_step_lifecycle() {
    let dir = setup_tmpdir();
    let task_file = format!("{}/lifecycle.yaml", dir);

    hal(&["task", "create", "--file", &task_file, "--goal", "Lifecycle test"], &dir);
    hal(&["step", "add", "--file", &task_file, "--step", "s1", "--goal", "Step 1"], &dir);

    // Start
    let (output, code) = hal(&["step", "start", "--file", &task_file, "--step", "s1"], &dir);
    assert_eq!(code, 0, "step start failed: {}", output);
    assert!(output.contains("Step started"));

    // Done
    let (output, code) = hal(&["step", "done", "--file", &task_file, "--step", "s1", "--result", "PASS", "--message", "Done"], &dir);
    assert_eq!(code, 0, "step done failed: {}", output);
    assert!(output.contains("Step completed"));

    // Check task is done
    let (output, _) = hal(&["status", "--file", &task_file], &dir);
    assert!(output.contains("done"));

    cleanup(&dir);
}

#[test]
fn test_step_verify_required() {
    let dir = setup_tmpdir();
    let task_file = format!("{}/verify.yaml", dir);

    hal(&["task", "create", "--file", &task_file, "--goal", "Verify test"], &dir);
    hal(&["step", "add", "--file", &task_file, "--step", "s1", "--goal", "Step 1", "--accept", "tests pass"], &dir);
    hal(&["step", "start", "--file", &task_file, "--step", "s1"], &dir);

    // Done without verify should fail
    let (output, code) = hal(&["step", "done", "--file", &task_file, "--step", "s1", "--result", "PASS", "--message", "Done"], &dir);
    assert_ne!(code, 0);
    assert!(output.contains("unverified"));

    // Verify then done
    hal(&["step", "verify", "--file", &task_file, "--step", "s1", "--result", "PASS", "--message", "OK"], &dir);
    let (output, code) = hal(&["step", "done", "--file", &task_file, "--step", "s1", "--result", "PASS", "--message", "Done"], &dir);
    assert_eq!(code, 0, "step done after verify failed: {}", output);

    cleanup(&dir);
}

#[test]
fn test_step_pause_resume() {
    let dir = setup_tmpdir();
    let task_file = format!("{}/pause.yaml", dir);

    hal(&["task", "create", "--file", &task_file, "--goal", "Pause test"], &dir);
    hal(&["step", "add", "--file", &task_file, "--step", "s1", "--goal", "Step 1"], &dir);
    hal(&["step", "start", "--file", &task_file, "--step", "s1"], &dir);

    let (output, code) = hal(&["step", "pause", "--file", &task_file, "--message", "Need input"], &dir);
    assert_eq!(code, 0);
    assert!(output.contains("Work paused"));

    let (output, code) = hal(&["step", "resume", "--file", &task_file], &dir);
    assert_eq!(code, 0);
    assert!(output.contains("Work resumed"));

    cleanup(&dir);
}

#[test]
fn test_check_allows_when_no_task() {
    let output = Command::new(env!("CARGO_BIN_EXE_hal"))
        .arg("check")
        .stdin(std::process::Stdio::piped())
        .output()
        .expect("Failed to run hal check");

    assert_eq!(output.status.code().unwrap_or(1), 0);
}

#[test]
fn test_task_edit() {
    let dir = setup_tmpdir();
    let task_file = format!("{}/edit.yaml", dir);

    hal(&["task", "create", "--file", &task_file, "--goal", "Original"], &dir);
    let (output, code) = hal(&["task", "edit", "--file", &task_file, "--goal", "Updated", "--message", "Changed"], &dir);
    assert_eq!(code, 0);
    assert!(output.contains("Task updated"));

    let (output, _) = hal(&["status", "--file", &task_file], &dir);
    assert!(output.contains("Updated"));

    cleanup(&dir);
}
