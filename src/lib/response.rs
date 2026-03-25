use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
pub struct HalResponse {
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<BTreeMap<String, serde_yaml::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands_hint: Option<String>,
}

impl HalResponse {
    pub fn new(status: &str, message: &str) -> Self {
        HalResponse {
            status: status.to_string(),
            message: message.to_string(),
            data: None,
            commands_hint: None,
        }
    }

    pub fn with_data(mut self, data: BTreeMap<String, serde_yaml::Value>) -> Self {
        self.data = Some(data);
        self
    }

    pub fn with_hint(mut self, hint: &str) -> Self {
        self.commands_hint = Some(hint.to_string());
        self
    }

    pub fn to_yaml(&self) -> String {
        serde_yaml::to_string(self).unwrap_or_else(|_| format!("status: {}\nmessage: {}\n", self.status, self.message))
    }
}
