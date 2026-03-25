pub const TASK_CREATED: &str = "Add steps with: hal step add --step <step-id> --goal '<goal>'";
pub const TASK_UPDATED: &str = "Check task state with: hal status";

pub const STEP_ADDED: &str = "Start the step with: hal step start --step <step-id>";
pub const STEP_STARTED: &str = "After completing work, spawn a sub-agent with the Agent tool to independently verify the accept criteria. The verifier runs hal step verify --message '<result>', then you can run hal step done --message '<summary>'. To switch to dialogue mode: hal step pause --message '<reason>'";

pub fn step_in_progress(step_id: &str) -> String {
    format!("Current step: {}. After completing work, run verification via sub-agent. To switch to dialogue mode: hal step pause --message '<reason>'", step_id)
}

#[allow(dead_code)]
pub fn step_verify_required(step_id: &str) -> String {
    format!("Step {} is unverified. Run hal step verify --step {} --result PASS|FAIL --message '<result>' via sub-agent", step_id, step_id)
}

pub fn step_done_next(next_step_id: &str) -> String {
    format!("Next step: hal step start --step {}", next_step_id)
}

pub const STEP_DONE_ALL: &str = "All steps completed. Create a CCR (Context Carry-over Report) summarizing the changes for the next task";
pub const STEP_DONE_FAIL: &str = "Fix the issues and report again with: hal step done --step <step-id> --result PASS --message '<summary>'";
pub const STEP_DONE_CHECK_STATUS: &str = "Check remaining steps with: hal status";
pub const STEP_PAUSED: &str = "Dialogue mode. Resume task work with: hal step resume";
pub const STEP_RESUMED: &str = "Task work resumed. Check current state with: hal status";

pub const STATUS_DONE: &str = "Task is complete. Create a CCR";
pub const STATUS_NO_STEPS: &str = "Add steps with: hal step add --step <step-id> --goal '<goal>'";
pub const STATUS_PENDING: &str = "Start a step with: hal step start --step <step-id>";
pub const STATUS_ADD_OR_CHECK: &str = "Add new steps with hal step add or check remaining work";

pub const CHECK_BLOCKED: &str = "Incomplete steps remain. Continue task work. If the user requests dialogue, or if you must confirm something with the user, use hal step pause --message '<reason>' to pause";

#[allow(dead_code)]
pub const NO_TASK: &str = "Dialogue mode. If multi-step work is needed, create a task with hal task create";
