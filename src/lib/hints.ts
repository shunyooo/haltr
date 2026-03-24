/**
 * Centralized command hints for agent guidance.
 */

export const HINTS = {
	// Task hints
	TASK_CREATED: "Add steps with: hal step add --step <step-id> --goal '<goal>'",
	TASK_UPDATED: "Check task state with: hal status",

	// Step hints
	STEP_ADDED: "Start the step with: hal step start --step <step-id>",
	STEP_STARTED:
		"After completing work, spawn a sub-agent with the Agent tool to independently verify the accept criteria. The verifier runs hal step verify --message '<result>', then you can run hal step done --message '<summary>'. To switch to dialogue mode: hal step pause --message '<reason>'",
	STEP_IN_PROGRESS: (stepId: string) =>
		`Current step: ${stepId}. After completing work, run verification via sub-agent. To switch to dialogue mode: hal step pause --message '<reason>'`,
	STEP_VERIFY_REQUIRED: (stepId: string) =>
		`Step ${stepId} is unverified. Run hal step verify --step ${stepId} --result PASS|FAIL --message '<result>' via sub-agent`,
	STEP_DONE_NEXT: (nextStepId: string) => `Next step: hal step start --step ${nextStepId}`,
	STEP_DONE_ALL:
		"All steps completed. Create a CCR (Context Carry-over Report) summarizing the changes for the next task",
	STEP_DONE_FAIL:
		"Fix the issues and report again with: hal step done --step <step-id> --result PASS --message '<summary>'",
	STEP_DONE_CHECK_STATUS: "Check remaining steps with: hal status",
	STEP_PAUSED: "Dialogue mode. Resume task work with: hal step resume",
	STEP_RESUMED:
		"Task work resumed. Check current state with: hal status",

	// Status hints
	STATUS_DONE: "Task is complete. Create a CCR",
	STATUS_NO_STEPS: "Add steps with: hal step add --step <step-id> --goal '<goal>'",
	STATUS_PENDING: "Start a step with: hal step start --step <step-id>",
	STATUS_ADD_OR_CHECK: "Add new steps with hal step add or check remaining work",

	// Check hints
	CHECK_BLOCKED:
		"Incomplete steps remain. Continue task work. If the user requests dialogue, or if you must confirm something with the user, use hal step pause --message '<reason>' to pause",

	// No task / dialogue mode hints
	NO_TASK:
		"Dialogue mode. If multi-step work is needed, create a task with hal task create",
} as const;
