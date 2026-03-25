use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    Pending,
    InProgress,
    Done,
    Failed,
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Status::Pending => write!(f, "pending"),
            Status::InProgress => write!(f, "in_progress"),
            Status::Done => write!(f, "done"),
            Status::Failed => write!(f, "failed"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept: Option<AcceptCriteria>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
}

/// Accept criteria can be a single string or a list of strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AcceptCriteria {
    Single(String),
    Multiple(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HistoryEvent {
    Created {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Updated {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    StepAdded {
        at: String,
        step: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    StepStarted {
        at: String,
        step: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    StepDone {
        at: String,
        step: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    StepFailed {
        at: String,
        step: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    StepVerified {
        at: String,
        step: String,
        result: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Paused {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Resumed {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Completed {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    UserFeedback {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskYaml {
    pub id: String,
    pub goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept: Option<AcceptCriteria>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<Step>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<HistoryEvent>>,
}
