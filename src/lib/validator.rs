use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

use crate::types::TaskYaml;

/// Load a YAML file and deserialize into TaskYaml.
pub fn load_and_validate_task(path: &Path) -> Result<TaskYaml> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("Failed to read task file: {}", path.display()))?;
    let task: TaskYaml = serde_yaml::from_str(&content)
        .with_context(|| format!("Failed to parse task file: {}", path.display()))?;
    Ok(task)
}

/// Serialize TaskYaml and write to file.
pub fn save_task(path: &Path, task: &TaskYaml) -> Result<()> {
    let content = serde_yaml::to_string(task)
        .context("Failed to serialize task")?;
    fs::write(path, content)
        .with_context(|| format!("Failed to write task file: {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Status, Step};

    #[test]
    fn test_load_valid_task() {
        let tmp = std::env::temp_dir().join("haltr-test-valid.yaml");
        let yaml = "id: test-001\ngoal: Test task\nstatus: pending\n";
        fs::write(&tmp, yaml).unwrap();
        let task = load_and_validate_task(&tmp).unwrap();
        assert_eq!(task.id, "test-001");
        assert_eq!(task.goal, "Test task");
        fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn test_load_invalid_yaml() {
        let tmp = std::env::temp_dir().join("haltr-test-invalid.yaml");
        fs::write(&tmp, "not: valid: yaml: [[[").unwrap();
        let result = load_and_validate_task(&tmp);
        assert!(result.is_err());
        fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn test_save_and_reload() {
        let tmp = std::env::temp_dir().join("haltr-test-roundtrip.yaml");
        let task = TaskYaml {
            id: "roundtrip".to_string(),
            goal: "Test roundtrip".to_string(),
            status: Some(Status::Pending),
            accept: None,
            plan: None,
            context: None,
            steps: Some(vec![Step {
                id: "s1".to_string(),
                goal: "Step 1".to_string(),
                status: Some(Status::Pending),
                accept: None,
                verified: None,
            }]),
            history: None,
        };
        save_task(&tmp, &task).unwrap();
        let loaded = load_and_validate_task(&tmp).unwrap();
        assert_eq!(loaded.id, "roundtrip");
        assert_eq!(loaded.steps.unwrap().len(), 1);
        fs::remove_file(&tmp).unwrap();
    }
}
