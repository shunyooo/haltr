/**
 * Story definitions for catalog (v3)
 */

export type StoryCategory =
	| "setup"
	| "task"
	| "step"
	| "status"
	| "check"
	| "hook"
	| "help";

export type StoryTag =
	| "success"
	| "error"
	| "edge-case"
	| "validation"
	| "workflow";

export interface Story {
	id: string;
	command: string;
	title: string;
	description?: string;
	category: StoryCategory;
	tags: StoryTag[];
	input: string;
	env?: Record<string, string>;
	setup?: "none" | "with-task" | "with-steps" | "with-steps-active" | "with-steps-active-no-accept" | "with-steps-active-unverified";
	expected_exit?: number;
}

export const stories: Story[] = [
	// ============================================================================
	// Help
	// ============================================================================
	{
		id: "help-root",
		command: "setup",
		title: "Show help",
		description: "Display hal help",
		category: "help",
		tags: ["success"],
		input: "hal --help",
	},
	{
		id: "help-task",
		command: "task create",
		title: "Task subcommand help",
		description: "Display hal task help",
		category: "help",
		tags: ["success"],
		input: "hal task --help",
	},
	{
		id: "help-step",
		command: "step add",
		title: "Step subcommand help",
		description: "Display hal step help",
		category: "help",
		tags: ["success"],
		input: "hal step --help",
	},

	// ============================================================================
	// Task
	// ============================================================================
	{
		id: "task-create-basic",
		command: "task create",
		title: "Basic task creation",
		description: "Create a task with goal only",
		category: "task",
		tags: ["success"],
		input: "hal task create --file task.yaml --goal 'Implement user authentication'",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "task-create-with-accept",
		command: "task create",
		title: "Task creation with accept criteria",
		description: "Create a task with goal and accept criteria",
		category: "task",
		tags: ["success"],
		input: "hal task create --file login.task.yaml --goal 'Implement login' --accept 'Can login with email and password' --accept 'Error message displayed on failure'",
		env: { HALTR_SESSION_ID: "test-session-002" },
	},
	{
		id: "task-create-no-goal",
		command: "task create",
		title: "Task creation without goal (error)",
		description: "Error when required --goal is missing",
		category: "task",
		tags: ["error", "validation"],
		input: "hal task create --file task.yaml",
	},
	{
		id: "task-edit-goal",
		command: "task edit",
		title: "Update task goal",
		description: "Change the task goal",
		category: "task",
		tags: ["success"],
		input: "hal task edit --file task.yaml --goal 'Implement OAuth2 user authentication' --message 'Switched to OAuth2'",
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},

	// ============================================================================
	// Step
	// ============================================================================
	{
		id: "step-add-basic",
		command: "step add",
		title: "Add step",
		description: "Add a step to the task",
		category: "step",
		tags: ["success"],
		input: "hal step add --file task.yaml --step s1 --goal 'Design database schema'",
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-add-with-accept",
		command: "step add",
		title: "Add step with accept criteria",
		description: "Add a step with accept criteria",
		category: "step",
		tags: ["success"],
		input: "hal step add --file task.yaml --step s2 --goal 'Implement API endpoints' --accept 'POST /login works' --accept 'Returns auth token'",
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-add-batch",
		command: "step add",
		title: "Batch add steps",
		description: "Add multiple steps from stdin YAML",
		category: "step",
		tags: ["success", "workflow"],
		input: `echo '- id: s1
  goal: Database design
  accept: ERD created
- id: s2
  goal: API implementation
  accept:
    - POST /login works
    - Returns auth token
- id: s3
  goal: Write tests' | hal step add --file task.yaml --stdin`,
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-start",
		command: "step start",
		title: "Start step",
		description: "Start working on a step",
		category: "step",
		tags: ["success"],
		input: "hal step start --file task.yaml --step s1",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-done-pass-verified",
		command: "step done",
		title: "Step done (accept + verified)",
		description: "Complete a verified step with accept criteria",
		category: "step",
		tags: ["success"],
		input: "hal step done --file task.yaml --step s1 --result PASS --message 'Schema design complete, created migrations/001_users.sql'",
		setup: "with-steps-active",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-done-pass-no-accept",
		command: "step done",
		title: "Step done (no accept, no verify needed)",
		description: "Steps without accept criteria can be completed without verification",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step done --file task.yaml --step s1 --result PASS --message 'Work complete'",
		setup: "with-steps-active-no-accept",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-done-pass-unverified",
		command: "step done",
		title: "Step done error (accept + unverified)",
		description: "Steps with accept criteria cannot be completed without verification",
		category: "step",
		tags: ["error", "validation"],
		input: "hal step done --file task.yaml --step s1 --result PASS --message 'Work complete'",
		setup: "with-steps-active-unverified",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-done-fail",
		command: "step done",
		title: "Step done (FAIL)",
		description: "Record step failure (no verify needed)",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step done --file task.yaml --step s1 --result FAIL --message 'External API spec unclear, need confirmation'",
		setup: "with-steps-active-no-accept",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-verify-pass",
		command: "step verify",
		title: "Step verify (PASS)",
		description: "Verify step meets accept criteria",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step verify --file task.yaml --step s1 --result PASS --message 'All tests pass, accept criteria met'",
		setup: "with-steps-active-unverified",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-verify-fail",
		command: "step verify",
		title: "Step verify (FAIL)",
		description: "Verify step does not meet accept criteria",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step verify --file task.yaml --step s1 --result FAIL --message '2 tests failing'",
		setup: "with-steps-active-unverified",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-pause",
		command: "step pause",
		title: "Pause work",
		description: "Pause for user dialogue",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step pause --file task.yaml --message 'Need to confirm auth approach'",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "step-resume",
		command: "step resume",
		title: "Resume work",
		description: "Resume paused work",
		category: "step",
		tags: ["success", "workflow"],
		input: "hal step resume --file task.yaml",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},

	// ============================================================================
	// Status
	// ============================================================================
	{
		id: "status-no-task",
		command: "status",
		title: "Status (no task)",
		description: "Error when no task exists",
		category: "status",
		tags: ["error", "edge-case"],
		input: "hal status",
		setup: "none",
	},
	{
		id: "status-with-task",
		command: "status",
		title: "Status (with task)",
		description: "Show status when task exists",
		category: "status",
		tags: ["success"],
		input: "hal status --file task.yaml",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},

	// ============================================================================
	// Check (Hook)
	// ============================================================================
	{
		id: "check-allow-done",
		command: "check",
		title: "Check allow (task done)",
		description: "Allow stop when task is complete",
		category: "check",
		tags: ["success", "workflow"],
		input: "echo '{\"session_id\":\"test-session-001\"}' | hal check",
		setup: "with-task",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
	{
		id: "check-block-incomplete",
		command: "check",
		title: "Check block (incomplete steps)",
		description: "Block stop when incomplete steps remain",
		category: "check",
		tags: ["workflow"],
		input: "echo '{\"session_id\":\"test-session-001\"}' | hal check",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
		expected_exit: 2,
	},

	// ============================================================================
	// Hook
	// ============================================================================
	{
		id: "session-start-new",
		command: "session-start",
		title: "Session start (no task)",
		description: "Start a new session without existing task",
		category: "hook",
		tags: ["success", "workflow"],
		input: "echo '{\"session_id\":\"new-session-001\"}' | hal session-start",
		setup: "none",
	},
	{
		id: "session-start-with-task",
		command: "session-start",
		title: "Session start (with task)",
		description: "Start a session with existing task",
		category: "hook",
		tags: ["success", "workflow"],
		input: "echo '{\"session_id\":\"test-session-001\"}' | hal session-start",
		setup: "with-steps",
		env: { HALTR_SESSION_ID: "test-session-001" },
	},
];
