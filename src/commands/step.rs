use anyhow::{Result, bail};
use std::collections::BTreeMap;
use std::io::Read;

use crate::core::hints;
use crate::core::response::HalResponse;
use crate::core::session::{get_session_id, set_session_task};
use crate::core::task_utils::resolve_task_file;
use crate::core::validator::{load_and_validate_task, save_task};
use crate::types::{AcceptCriteria, HistoryEvent, Status, Step};

fn find_step_index(steps: &[Step], step_id: &str) -> Option<usize> {
    steps.iter().position(|s| s.id == step_id)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn yaml_str(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_string())
}

pub fn handle_step_add(
    file: Option<&str>, step_id: &str, goal: &str, accept: &[String], after: Option<&str>,
) -> Result<()> {
    let task_path = resolve_task_file(file)?;
    let mut task = load_and_validate_task(&task_path)?;
    let steps = task.steps.get_or_insert_with(Vec::new);

    if find_step_index(steps, step_id).is_some() {
        bail!("Step ID \"{}\" already exists", step_id);
    }

    let mut new_step = Step {
        id: step_id.to_string(),
        goal: goal.to_string(),
        status: Some(Status::Pending),
        accept: None,
        verified: None,
    };

    if !accept.is_empty() {
        new_step.accept = Some(if accept.len() == 1 {
            AcceptCriteria::Single(accept[0].clone())
        } else {
            AcceptCriteria::Multiple(accept.to_vec())
        });
    }

    if let Some(after_id) = after {
        let idx = find_step_index(steps, after_id)
            .ok_or_else(|| anyhow::anyhow!("Step \"{}\" specified in --after not found", after_id))?;
        steps.insert(idx + 1, new_step);
    } else {
        steps.push(new_step);
    }

    let history = task.history.get_or_insert_with(Vec::new);
    history.push(HistoryEvent::StepAdded {
        at: now(),
        step: step_id.to_string(),
        message: Some(format!("Step added: {}", goal)),
    });

    save_task(&task_path, &task)?;

    let mut data = BTreeMap::new();
    data.insert("step_id".into(), yaml_str(step_id));
    data.insert("goal".into(), yaml_str(goal));
    data.insert("status".into(), yaml_str("pending"));

    let response = HalResponse::new("ok", &format!("Step added: {}", step_id))
        .with_data(data)
        .with_hint(hints::STEP_ADDED);
    println!("{}", response.to_yaml());
    Ok(())
}

pub fn handle_step_add_batch(file: Option<&str>) -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let input = input.trim();
    if input.is_empty() {
        bail!("Failed to read step data from stdin");
    }

    let steps_input: Vec<serde_yaml::Value> = serde_yaml::from_str(input)?;
    if steps_input.is_empty() {
        bail!("stdin must be a YAML array");
    }

    let task_path = resolve_task_file(file)?;
    let mut task = load_and_validate_task(&task_path)?;
    let steps = task.steps.get_or_insert_with(Vec::new);
    let history = task.history.get_or_insert_with(Vec::new);
    let ts = now();

    let mut added = vec![];
    let mut seen_ids = std::collections::HashSet::new();

    for entry in &steps_input {
        let id = entry.get("id").and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Step requires id and goal"))?;
        let goal = entry.get("goal").and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Step requires id and goal"))?;

        if !seen_ids.insert(id.to_string()) {
            bail!("Duplicate step ID in input: \"{}\"", id);
        }
        if find_step_index(steps, id).is_some() {
            bail!("Step ID \"{}\" already exists", id);
        }

        let accept = entry.get("accept").map(|v| match v {
            serde_yaml::Value::String(s) => AcceptCriteria::Single(s.clone()),
            serde_yaml::Value::Sequence(arr) => {
                AcceptCriteria::Multiple(arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            }
            _ => AcceptCriteria::Single(format!("{:?}", v)),
        });

        steps.push(Step {
            id: id.to_string(),
            goal: goal.to_string(),
            status: Some(Status::Pending),
            accept,
            verified: None,
        });

        history.push(HistoryEvent::StepAdded {
            at: ts.clone(),
            step: id.to_string(),
            message: Some(format!("Step added: {}", goal)),
        });

        added.push(id.to_string());
    }

    save_task(&task_path, &task)?;

    let mut data = BTreeMap::new();
    let added_yaml: Vec<serde_yaml::Value> = added.iter().map(|s| yaml_str(s)).collect();
    data.insert("added".into(), serde_yaml::Value::Sequence(added_yaml));

    let response = HalResponse::new("ok", &format!("{} steps added", added.len()))
        .with_data(data)
        .with_hint(hints::STEP_ADDED);
    println!("{}", response.to_yaml());
    Ok(())
}

pub fn handle_step_start(file: Option<&str>, step_id: &str) -> Result<()> {
    let task_path = resolve_task_file(file)?;
    let mut task = load_and_validate_task(&task_path)?;

    // Validate and mutate steps
    let step_goal = {
        let steps = task.steps.get_or_insert_with(Vec::new);
        let idx = find_step_index(steps, step_id)
            .ok_or_else(|| anyhow::anyhow!("Step \"{}\" not found", step_id))?;
        let current = steps[idx].status.as_ref().unwrap_or(&Status::Pending);
        if *current != Status::Pending && *current != Status::Failed {
            bail!("Step \"{}\" is currently {}. Only pending or failed steps can be started", step_id, current);
        }
        steps[idx].status = Some(Status::InProgress);
        steps[idx].goal.clone()
    };

    if task.status.as_ref().unwrap_or(&Status::Pending) == &Status::Pending {
        task.status = Some(Status::InProgress);
    }

    let history = task.history.get_or_insert_with(Vec::new);
    history.push(HistoryEvent::StepStarted {
        at: now(),
        step: step_id.to_string(),
        message: None,
    });

    save_task(&task_path, &task)?;

    if let Ok(session_id) = get_session_id() {
        let _ = set_session_task(&session_id, task_path.to_str().unwrap_or(""));
    }

    let mut data = BTreeMap::new();
    data.insert("step_id".into(), yaml_str(step_id));
    data.insert("step_goal".into(), yaml_str(&step_goal));
    data.insert("step_status".into(), yaml_str("in_progress"));
    data.insert("task_goal".into(), yaml_str(&task.goal));
    data.insert("task_status".into(), yaml_str(&task.status.as_ref().unwrap().to_string()));

    let response = HalResponse::new("ok", &format!("Step started: {}", step_id))
        .with_data(data)
        .with_hint(hints::STEP_STARTED);
    println!("{}", response.to_yaml());
    Ok(())
}

pub fn handle_step_done(file: Option<&str>, step_id: &str, result: &str, message: &str) -> Result<()> {
    let result_upper = result.to_uppercase();
    if result_upper != "PASS" && result_upper != "FAIL" {
        bail!("--result must be PASS or FAIL");
    }

    let task_path = resolve_task_file(file)?;
    let mut task = load_and_validate_task(&task_path)?;

    // Validate and mutate steps in a block to release borrow
    {
        let steps = task.steps.get_or_insert_with(Vec::new);
        let idx = find_step_index(steps, step_id)
            .ok_or_else(|| anyhow::anyhow!("Step \"{}\" not found", step_id))?;

        let current = steps[idx].status.as_ref().unwrap_or(&Status::Pending);
        if *current != Status::InProgress {
            bail!("Step \"{}\" is currently {}. Only in_progress steps can be marked done", step_id, current);
        }

        if result_upper == "PASS" && steps[idx].accept.is_some() && steps[idx].verified != Some(true) {
            bail!("Step \"{}\" is unverified. Run hal step verify --step {} --result PASS|FAIL via sub-agent first", step_id, step_id);
        }

        if result_upper == "PASS" {
            steps[idx].status = Some(Status::Done);
        }
    }

    let ts = now();
    let history = task.history.get_or_insert_with(Vec::new);

    if result_upper == "PASS" {
        history.push(HistoryEvent::StepDone {
            at: ts.clone(),
            step: step_id.to_string(),
            message: Some(message.to_string()),
        });
    } else {
        history.push(HistoryEvent::StepFailed {
            at: ts.clone(),
            step: step_id.to_string(),
            message: Some(message.to_string()),
        });
    }

    let steps = task.steps.as_ref().unwrap();
    let all_done = !steps.is_empty() && steps.iter().all(|s| s.status.as_ref() == Some(&Status::Done));
    if all_done {
        task.status = Some(Status::Done);
        let history = task.history.get_or_insert_with(Vec::new);
        history.push(HistoryEvent::Completed {
            at: ts,
            message: Some("All steps completed".to_string()),
        });
    }

    save_task(&task_path, &task)?;

    let steps = task.steps.as_ref().unwrap();
    let step_status = steps.iter().find(|s| s.id == step_id).unwrap().status.as_ref().unwrap().to_string();

    let mut data = BTreeMap::new();
    data.insert("step_id".into(), yaml_str(step_id));
    data.insert("result".into(), yaml_str(&result_upper));
    data.insert("step_status".into(), yaml_str(&step_status));
    data.insert("task_status".into(), yaml_str(&task.status.as_ref().unwrap_or(&Status::Pending).to_string()));

    let hint = if all_done {
        hints::STEP_DONE_ALL.to_string()
    } else if result_upper == "FAIL" {
        hints::STEP_DONE_FAIL.to_string()
    } else {
        steps.iter()
            .find(|s| s.status.as_ref().unwrap_or(&Status::Pending) == &Status::Pending)
            .map(|s| hints::step_done_next(&s.id))
            .unwrap_or_else(|| hints::STEP_DONE_CHECK_STATUS.to_string())
    };

    let msg = if result_upper == "PASS" {
        format!("Step completed: {}", step_id)
    } else {
        format!("Step failed: {}", step_id)
    };

    let response = HalResponse::new("ok", &msg).with_data(data).with_hint(&hint);
    println!("{}", response.to_yaml());
    Ok(())
}

pub fn handle_step_pause(file: Option<&str>, message: &str) -> Result<()> {
    let task_path = resolve_task_file(file)?;
    let mut task = load_and_validate_task(&task_path)?;

    let history = task.history.get_or_insert_with(Vec::new);
    history.push(HistoryEvent::Paused {
        at: now(),
        message: Some(message.to_string()),
    });

    save_task(&task_path, &task)?;

    let mut data = BTreeMap::new();
    data.insert("task_status".into(), yaml_str(&task.status.as_ref().unwrap_or(&Status::Pending).to_string()));
    data.insert("paused".into(), serde_yaml::Value::Bool(true));
    data.insert("pause_reason".into(), yaml_str(message));

    let response = HalResponse::new("ok", &format!("Work paused: {}", message))
        .with_data(data)
        .with_hint(hints::STEP_PAUSED);
    println!("{}", response.to_yaml());
    Ok(())
}

pub fn handle_step_resume(file: Option<&str>) -> Result<()> {
    let task_path = resolve_task_file(file)?;
    let mut task = load_and_validate_task(&task_path)?;

    let history = task.history.get_or_insert_with(Vec::new);
    history.push(HistoryEvent::Resumed {
        at: now(),
        message: Some("Work resumed".to_string()),
    });

    save_task(&task_path, &task)?;

    let mut data = BTreeMap::new();
    data.insert("task_status".into(), yaml_str(&task.status.as_ref().unwrap_or(&Status::Pending).to_string()));

    let response = HalResponse::new("ok", "Work resumed")
        .with_data(data)
        .with_hint(hints::STEP_RESUMED);
    println!("{}", response.to_yaml());
    Ok(())
}

pub fn handle_step_verify(file: Option<&str>, step_id: &str, result: &str, message: &str) -> Result<()> {
    let result_upper = result.to_uppercase();
    if result_upper != "PASS" && result_upper != "FAIL" {
        bail!("--result must be PASS or FAIL");
    }

    let task_path = resolve_task_file(file)?;
    let mut task = load_and_validate_task(&task_path)?;

    let verified = {
        let steps = task.steps.as_mut().ok_or_else(|| anyhow::anyhow!("Task has no steps"))?;
        let idx = find_step_index(steps, step_id)
            .ok_or_else(|| anyhow::anyhow!("Step \"{}\" not found", step_id))?;
        steps[idx].verified = Some(result_upper == "PASS");
        steps[idx].verified.unwrap_or(false)
    };

    let history = task.history.get_or_insert_with(Vec::new);
    history.push(HistoryEvent::StepVerified {
        at: now(),
        step: step_id.to_string(),
        result: result_upper.clone(),
        message: Some(message.to_string()),
    });

    save_task(&task_path, &task)?;

    let mut data = BTreeMap::new();
    data.insert("step_id".into(), yaml_str(step_id));
    data.insert("result".into(), yaml_str(&result_upper));
    data.insert("verified".into(), serde_yaml::Value::Bool(verified));

    let hint = if result_upper == "PASS" {
        hints::step_done_next(step_id)
    } else {
        hints::STEP_DONE_FAIL.to_string()
    };

    let msg = if result_upper == "PASS" {
        format!("Verification passed: step {}", step_id)
    } else {
        format!("Verification failed: step {}", step_id)
    };

    let response = HalResponse::new("ok", &msg).with_data(data).with_hint(&hint);
    println!("{}", response.to_yaml());
    Ok(())
}
