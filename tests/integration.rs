use std::fs;
use std::process::Command;

fn hal(args: &[&str]) -> (String, i32) {
    let output = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(args)
        .output()
        .expect("Failed to run hal");

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{}{}", stdout, stderr);
    (combined, output.status.code().unwrap_or(1))
}

fn hal_in(args: &[&str], cwd: &str) -> (String, i32) {
    let output = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(args)
        .current_dir(cwd)
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
    let dir = std::env::temp_dir().join(format!("haltr-test-{}-{}", std::process::id(), id));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.to_str().unwrap().to_string()
}

fn cleanup(dir: &str) {
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_help() {
    let (output, code) = hal(&["--help"]);
    assert_eq!(code, 0);
    assert!(output.contains("haltr"));
    assert!(output.contains("quality gate"));
}

#[test]
fn test_version() {
    let (output, code) = hal(&["--version"]);
    assert_eq!(code, 0);
    assert!(output.contains("5."));
}

#[test]
fn test_setup_creates_structure() {
    let dir = setup_tmpdir();

    let (output, code) = hal_in(&["setup"], &dir);
    assert_eq!(code, 0, "setup failed: {}", output);
    assert!(output.contains("setup complete"));

    // Check directory structure
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/agents/dispatcher.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/agents/critic-orchestrator.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/agents/memory-writer.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/agents/critics/memory-feedback-reader.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/agents/critics/expert-skeptic.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/agents/critics/guard-l1.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/agents/critics/guard-l2.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/agents/critics/guard-l3.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/memory/00_index.md")).exists());
    assert!(std::path::Path::new(&format!("{}/{}", dir, ".haltr/logs")).is_dir());

    // Check settings.json has hook registered
    let settings = fs::read_to_string(format!("{}/{}", dir, ".claude/settings.json")).unwrap();
    assert!(settings.contains("hal hook stop"));
    assert!(settings.contains("Stop"));

    cleanup(&dir);
}

#[test]
fn test_setup_idempotent() {
    let dir = setup_tmpdir();

    hal_in(&["setup"], &dir);

    // User edits a reviewer file
    let reviewer_path = format!("{}/{}", dir, ".haltr/agents/critics/expert-skeptic.md");
    fs::write(&reviewer_path, "# custom reviewer\nuser edited").unwrap();

    let (output, code) = hal_in(&["setup"], &dir);
    assert_eq!(code, 0, "second setup failed: {}", output);

    // Should not duplicate the hook entry
    let settings = fs::read_to_string(format!("{}/{}", dir, ".claude/settings.json")).unwrap();
    let count = settings.matches("hal hook stop").count();
    assert_eq!(count, 1, "hook registered more than once");

    // Should preserve user-edited reviewer
    let content = fs::read_to_string(&reviewer_path).unwrap();
    assert!(content.contains("user edited"), "setup overwrote user-edited reviewer");

    cleanup(&dir);
}

#[test]
fn test_critic_disable_enable_global() {
    // Global kill switch
    let kill_path = "/tmp/haltr-disabled";
    let _ = fs::remove_file(kill_path);

    let (output, code) = hal(&["critic", "disable", "--all"]);
    assert_eq!(code, 0, "critic disable failed: {}", output);
    assert!(std::path::Path::new(kill_path).exists());

    let (output, code) = hal(&["critic", "enable", "--all"]);
    assert_eq!(code, 0, "critic enable failed: {}", output);
    assert!(!std::path::Path::new(kill_path).exists());
}

#[test]
fn test_critic_disable_enable_session() {
    let session_id = "test-session-12345678";
    let state_path = format!("/tmp/haltr-{}.json", session_id);
    let _ = fs::remove_file(&state_path);

    // Disable
    let output = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(["critic", "disable"])
        .env("HALTR_SESSION_ID", session_id)
        .output()
        .expect("Failed to run hal");
    assert!(output.status.success());

    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&state_path).unwrap()
    ).unwrap();
    assert_eq!(state["critic_enabled"], false);

    // Enable
    let output = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(["critic", "enable"])
        .env("HALTR_SESSION_ID", session_id)
        .output()
        .expect("Failed to run hal");
    assert!(output.status.success());

    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&state_path).unwrap()
    ).unwrap();
    assert_eq!(state["critic_enabled"], true);

    let _ = fs::remove_file(&state_path);
}

#[test]
fn test_hook_stop_exits_on_nested() {
    let output = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(["hook", "stop"])
        .env("CLAUDE_HOOK_NESTED", "1")
        .stdin(std::process::Stdio::piped())
        .output()
        .expect("Failed to run hal");

    assert_eq!(output.status.code().unwrap(), 0, "nested hook should exit 0");
}

#[test]
fn test_hook_stop_exits_on_global_kill_switch() {
    let kill_path = "/tmp/haltr-disabled";
    fs::write(kill_path, "").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(["hook", "stop"])
        .stdin(std::process::Stdio::piped())
        .output()
        .expect("Failed to run hal");

    assert_eq!(output.status.code().unwrap(), 0);

    let _ = fs::remove_file(kill_path);
}

#[test]
fn test_hook_stop_exits_on_empty_input() {
    let _ = fs::remove_file("/tmp/haltr-disabled");

    let mut child = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(["hook", "stop"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("Failed to run hal");

    // Close stdin immediately (empty input)
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();

    // Should exit 0 (fail-open on missing transcript)
    assert_eq!(output.status.code().unwrap(), 0);
}

#[test]
fn test_memory_stats_empty() {
    let dir = setup_tmpdir();
    hal_in(&["setup"], &dir);

    let (output, code) = hal_in(&["memory", "stats"], &dir);
    assert_eq!(code, 0, "memory stats failed: {}", output);
    assert!(output.contains("No memory stats yet"), "unexpected output: {}", output);

    cleanup(&dir);
}

#[test]
fn test_memory_stats_populated() {
    let dir = setup_tmpdir();
    hal_in(&["setup"], &dir);

    // Pre-populate stats file
    let stats_path = format!("{}/.haltr/memory/00_stats.json", dir);
    fs::write(&stats_path, r#"{
      "entries": {
        "alpha.md": {"checks": 10, "hits": 3, "last_hit": "2026-05-07T08:00:00Z", "last_check": "2026-05-07T09:00:00Z"},
        "beta.md":  {"checks": 10, "hits": 0, "last_check": "2026-05-07T09:00:00Z"}
      },
      "updated_at": "2026-05-07T09:00:00Z"
    }"#).unwrap();

    let (output, code) = hal_in(&["memory", "stats"], &dir);
    assert_eq!(code, 0, "memory stats failed: {}", output);
    assert!(output.contains("alpha.md"));
    assert!(output.contains("beta.md"));
    assert!(output.contains("30.0%"));   // hit rate for alpha
    assert!(output.contains("0.0%"));    // hit rate for beta

    cleanup(&dir);
}

#[test]
fn test_memory_hits_finds_event() {
    let dir = setup_tmpdir();
    hal_in(&["setup"], &dir);

    // Synthesize a verdict log entry with a memory-feedback-reader finding
    // whose haltr-stats fence lists "target.md" as matched.
    let log_dir = format!("{}/.haltr/logs", dir);
    fs::create_dir_all(&log_dir).unwrap();
    let log_path = format!("{}/sess-1.jsonl", log_dir);

    let detail = "# memory-feedback-reader verdict\nseverity: red\n\n## Matched entries\n- target\n\n```haltr-stats\n{\"checked\":[\"target.md\",\"other.md\"],\"matched\":[{\"entry\":\"target.md\",\"severity\":\"red\"}]}\n```";
    let entry = serde_json::json!({
        "ts": "2026-05-07T08:00:00Z",
        "layer": "verdict",
        "decision": "block",
        "critic_session_id": "abc12345",
        "findings": [
            {
                "critic": "memory-feedback-reader",
                "severity": "red",
                "title": "recurrence",
                "detail": detail,
            }
        ]
    });
    fs::write(&log_path, format!("{}\n", entry)).unwrap();

    let (output, code) = hal_in(&["memory", "hits", "target.md"], &dir);
    assert_eq!(code, 0, "memory hits failed: {}", output);
    assert!(output.contains("1 hit found"), "expected hit count: {}", output);
    assert!(output.contains("session=abc12345"));
    assert!(output.contains("severity=red"));

    cleanup(&dir);
}

#[test]
fn test_memory_hits_not_found() {
    let dir = setup_tmpdir();
    hal_in(&["setup"], &dir);

    let (output, code) = hal_in(&["memory", "hits", "missing.md"], &dir);
    assert_eq!(code, 0, "memory hits failed: {}", output);
    assert!(output.contains("No hits found"));

    cleanup(&dir);
}

#[test]
fn test_migrate_hint_emits_brief() {
    let (output, code) = hal(&["migrate", "hint"]);
    assert_eq!(code, 0, "migrate hint failed: {}", output);
    assert!(output.contains(".haltr/agents/memory-writer.md"));
    assert!(output.contains(".haltr/agents/critics/memory-feedback-reader.md"));
    assert!(output.contains("\"wrote\""));
    assert!(output.contains("haltr-stats"));
    assert!(output.contains("### Bundled current version"));
}

#[test]
fn test_migrate_hint_section_for_each_bundled_agent() {
    let (output, code) = hal(&["migrate", "hint"]);
    assert_eq!(code, 0);
    for path in [
        ".haltr/agents/memory-writer.md",
        ".haltr/agents/dispatcher.md",
        ".haltr/agents/critic-orchestrator.md",
        ".haltr/agents/critics/memory-feedback-reader.md",
    ] {
        assert!(
            output.contains(path),
            "expected migrate hint to mention {}, got:\n{}",
            path, output,
        );
    }
}

#[test]
fn test_hook_stop_session_disabled() {
    let session_id = "test-hook-disabled-session";
    let state_path = format!("/tmp/haltr-{}.json", session_id);
    let _ = fs::remove_file("/tmp/haltr-disabled");

    // Disable critic for this session
    fs::write(&state_path, r#"{"critic_enabled":false,"critic_iter":0,"transcript_size":0}"#).unwrap();

    // Create a fake transcript
    let tmpdir = setup_tmpdir();
    let transcript_path = format!("{}/transcript.jsonl", tmpdir);
    fs::write(&transcript_path, "").unwrap();

    let input = serde_json::json!({
        "session_id": session_id,
        "transcript_path": transcript_path
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_hal"))
        .args(["hook", "stop"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("Failed to run hal");

    use std::io::Write;
    child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();

    assert_eq!(output.status.code().unwrap(), 0, "disabled session should exit 0");

    let _ = fs::remove_file(&state_path);
    cleanup(&tmpdir);
}
