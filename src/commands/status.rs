use anyhow::Result;
use std::collections::BTreeMap;

use crate::core::hints;
use crate::core::response::HalResponse;
use crate::core::task_utils::resolve_task_file;
use crate::core::validator::load_and_validate_task;
use crate::types::Status;

pub fn handle_status(file: Option<&str>) -> Result<()> {
    let task_path = resolve_task_file(file)?;
    let task = load_and_validate_task(&task_path)?;

    let task_status = task.status.as_ref().unwrap_or(&Status::Pending);
    let steps = task.steps.as_deref().unwrap_or(&[]);

    let mut data = BTreeMap::new();
    data.insert("task_path".into(), serde_yaml::Value::String(task_path.display().to_string()));
    data.insert("task_id".into(), serde_yaml::Value::String(task.id.clone()));
    data.insert("goal".into(), serde_yaml::Value::String(task.goal.clone()));
    data.insert("status".into(), serde_yaml::Value::String(task_status.to_string()));

    let steps_yaml: Vec<serde_yaml::Value> = steps.iter().map(|s| {
        let mut m = serde_yaml::Mapping::new();
        m.insert(serde_yaml::Value::String("id".into()), serde_yaml::Value::String(s.id.clone()));
        m.insert(serde_yaml::Value::String("goal".into()), serde_yaml::Value::String(s.goal.clone()));
        m.insert(serde_yaml::Value::String("status".into()), serde_yaml::Value::String(s.status.as_ref().unwrap_or(&Status::Pending).to_string()));
        serde_yaml::Value::Mapping(m)
    }).collect();
    data.insert("steps".into(), serde_yaml::Value::Sequence(steps_yaml));

    let hint = match task_status {
        Status::Done => hints::STATUS_DONE.to_string(),
        Status::Pending if steps.is_empty() => hints::STATUS_NO_STEPS.to_string(),
        Status::Pending => hints::STATUS_PENDING.to_string(),
        _ => {
            if let Some(s) = steps.iter().find(|s| s.status.as_ref() == Some(&Status::InProgress)) {
                hints::step_in_progress(&s.id)
            } else if let Some(s) = steps.iter().find(|s| s.status.as_ref().unwrap_or(&Status::Pending) == &Status::Pending) {
                hints::step_done_next(&s.id)
            } else {
                hints::STATUS_ADD_OR_CHECK.to_string()
            }
        }
    };

    let response = HalResponse::new("ok", &format!("Task status: {}", task_status))
        .with_data(data)
        .with_hint(&hint);
    println!("{}", response.to_yaml());
    Ok(())
}
