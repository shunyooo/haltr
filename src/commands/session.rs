use std::io::Read;

pub fn handle_session_start() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() || input.trim().is_empty() {
        std::process::exit(0);
    }

    let data: serde_json::Value = match serde_json::from_str(input.trim()) {
        Ok(v) => v,
        Err(_) => std::process::exit(0),
    };

    let session_id = match data.get("session_id").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => std::process::exit(0),
    };

    let env_file = match std::env::var("CLAUDE_ENV_FILE") {
        Ok(f) => f,
        Err(_) => std::process::exit(0),
    };

    let line = format!("export HALTR_SESSION_ID={}\n", session_id);
    if std::fs::OpenOptions::new().append(true).open(&env_file)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()))
        .is_err()
    {
        std::process::exit(0);
    }

    std::process::exit(0);
}
