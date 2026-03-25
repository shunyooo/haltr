use anyhow::{Result, bail};
use std::collections::BTreeMap;
use std::path::Path;

use crate::core::hints;
use crate::core::response::HalResponse;
use crate::core::session::{get_session_id, set_session_task};
use crate::core::validator::{load_and_validate_task, save_task};
use crate::core::task_utils::resolve_task_file;
use crate::types::{AcceptCriteria, HistoryEvent, Status, TaskYaml};

pub fn handle_task_create(file: &str, goal: &str, accept: &[String], plan: Option<&str>) -> Result<()> {
    let path = Path::new(file);
    if path.exists() {
        bail!("File already exists: {}", path.display());
    }

    let task_id = file
        .trim_end_matches(".yaml")
        .trim_end_matches(".yml")
        .trim_end_matches(".task");

    let now = chrono::Utc::now().to_rfc3339();

    let mut task = TaskYaml {
        id: task_id.to_string(),
        goal: goal.to_string(),
        status: Some(Status::Pending),
        accept: None,
        plan: plan.map(|s| s.to_string()),
        context: None,
        steps: Some(vec![]),
        history: Some(vec![HistoryEvent::Created {
            at: now,
            message: Some("Task created".to_string()),
        }]),
    };

    if !accept.is_empty() {
        task.accept = Some(if accept.len() == 1 {
            AcceptCriteria::Single(accept[0].clone())
        } else {
            AcceptCriteria::Multiple(accept.to_vec())
        });
    }

    save_task(path, &task)?;

    // Save session mapping
    if let Ok(session_id) = get_session_id() {
        let abs_path = std::fs::canonicalize(path)?;
        let _ = set_session_task(&session_id, abs_path.to_str().unwrap_or(file));
    }

    let mut data = BTreeMap::new();
    data.insert("task_path".into(), serde_yaml::Value::String(file.to_string()));
    data.insert("task_id".into(), serde_yaml::Value::String(task_id.to_string()));
    data.insert("goal".into(), serde_yaml::Value::String(goal.to_string()));
    data.insert("status".into(), serde_yaml::Value::String("pending".to_string()));

    let response = HalResponse::new("ok", &format!("Task created: {}", file))
        .with_data(data)
        .with_hint(hints::TASK_CREATED);

    println!("{}", response.to_yaml());
    Ok(())
}

pub fn handle_task_edit(file: Option<&str>, goal: Option<&str>, accept: &[String], plan: Option<&str>, message: &str) -> Result<()> {
    let task_path = resolve_task_file(file)?;
    let mut task = load_and_validate_task(&task_path)?;

    let mut changes = vec![];

    if let Some(g) = goal {
        task.goal = g.to_string();
        changes.push("goal");
    }

    if !accept.is_empty() {
        task.accept = Some(if accept.len() == 1 {
            AcceptCriteria::Single(accept[0].clone())
        } else {
            AcceptCriteria::Multiple(accept.to_vec())
        });
        changes.push("accept");
    }

    if let Some(p) = plan {
        task.plan = Some(p.to_string());
        changes.push("plan");
    }

    if changes.is_empty() {
        bail!("No fields specified to update");
    }

    let now = chrono::Utc::now().to_rfc3339();
    let history = task.history.get_or_insert_with(Vec::new);
    history.push(HistoryEvent::Updated {
        at: now,
        message: Some(format!("{} (changed: {})", message, changes.join(", "))),
    });

    save_task(&task_path, &task)?;

    let mut data = BTreeMap::new();
    data.insert("task_path".into(), serde_yaml::Value::String(task_path.display().to_string()));
    let changes_yaml: Vec<serde_yaml::Value> = changes.iter().map(|c| serde_yaml::Value::String(c.to_string())).collect();
    data.insert("updated_fields".into(), serde_yaml::Value::Sequence(changes_yaml));

    let response = HalResponse::new("ok", &format!("Task updated: {}", changes.join(", ")))
        .with_data(data)
        .with_hint(hints::TASK_UPDATED);

    println!("{}", response.to_yaml());
    Ok(())
}
