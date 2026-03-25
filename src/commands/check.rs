use std::collections::BTreeMap;
use std::io::Read;

use crate::core::hints;
use crate::core::response::HalResponse;
use crate::core::session::get_task_path_for_session;
use crate::core::validator::load_and_validate_task;
use crate::types::Status;

pub fn handle_check() {
    let mut stdin_content = String::new();
    if std::io::stdin().read_to_string(&mut stdin_content).is_err() || stdin_content.trim().is_empty() {
        std::process::exit(0);
    }

    let stdin_data: serde_json::Value = match serde_json::from_str(stdin_content.trim()) {
        Ok(v) => v,
        Err(_) => std::process::exit(0),
    };

    let session_id = match stdin_data.get("session_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => std::process::exit(0),
    };

    let task_path = match get_task_path_for_session(&session_id) {
        Some(p) => p,
        None => std::process::exit(0),
    };

    let task = match load_and_validate_task(std::path::Path::new(&task_path)) {
        Ok(t) => t,
        Err(_) => std::process::exit(0),
    };

    // Paused -> allow
    if let Some(history) = &task.history {
        if let Some(last) = history.last() {
            if matches!(last, crate::types::HistoryEvent::Paused { .. }) {
                std::process::exit(0);
            }
        }
    }

    let steps = task.steps.as_deref().unwrap_or(&[]);
    let all_done = !steps.is_empty() && steps.iter().all(|s| s.status.as_ref() == Some(&Status::Done));
    if all_done {
        std::process::exit(0);
    }

    let task_status = task.status.as_ref().unwrap_or(&Status::Pending);
    if *task_status == Status::Pending || *task_status == Status::Done {
        std::process::exit(0);
    }

    // Block
    let remaining: Vec<serde_yaml::Value> = steps.iter()
        .filter(|s| s.status.as_ref() != Some(&Status::Done))
        .map(|s| {
            let mut m = serde_yaml::Mapping::new();
            m.insert("id".into(), serde_yaml::Value::String(s.id.clone()));
            m.insert("goal".into(), serde_yaml::Value::String(s.goal.clone()));
            m.insert("status".into(), serde_yaml::Value::String(s.status.as_ref().unwrap_or(&Status::Pending).to_string()));
            serde_yaml::Value::Mapping(m)
        })
        .collect();

    let mut data = BTreeMap::new();
    data.insert("task_goal".into(), serde_yaml::Value::String(task.goal));
    data.insert("task_status".into(), serde_yaml::Value::String(task_status.to_string()));
    data.insert("remaining_steps".into(), serde_yaml::Value::Sequence(remaining));

    let response = HalResponse::new("blocked", "Incomplete steps remain")
        .with_data(data)
        .with_hint(hints::CHECK_BLOCKED);

    eprintln!("{}", response.to_yaml());
    std::process::exit(2);
}
