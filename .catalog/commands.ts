/**
 * Command metadata extracted from hal.ts
 */

export interface CommandOption {
	name: string;
	required: boolean;
	description: string;
	choices?: string[];
}

export interface CommandMeta {
	name: string;
	description: string;
	detail?: string;
	options: CommandOption[];
}

export const commands: Record<string, CommandMeta> = {
	setup: {
		name: "setup",
		description: "Register haltr hooks in ~/.claude/settings.json",
		detail: "Registers SessionStart and Stop hooks. Run once.",
		options: [],
	},
	"task create": {
		name: "task create",
		description: "Create a new task file",
		detail: "Creates task.yaml at the specified path. Session mapping is auto-registered.",
		options: [
			{ name: "--file", required: true, description: "Task file path (required)" },
			{ name: "--goal", required: true, description: "Task goal" },
			{ name: "--accept", required: false, description: "Accept criteria (repeatable)" },
			{ name: "--plan", required: false, description: "Task plan" },
		],
	},
	"task edit": {
		name: "task edit",
		description: "Edit the current task",
		detail: "Updates goal or accept criteria. Changes recorded in history as updated event.",
		options: [
			{ name: "--file", required: false, description: "Task file path" },
			{ name: "--goal", required: false, description: "New goal" },
			{ name: "--accept", required: false, description: "New accept criteria (repeatable)" },
			{ name: "--plan", required: false, description: "New plan" },
			{ name: "--message", required: true, description: "Change reason" },
		],
	},
	"step add": {
		name: "step add",
		description: "Add a new step to the task",
		detail: "Add steps in single mode (--step --goal) or batch mode (--stdin).",
		options: [
			{ name: "--file", required: false, description: "Task file path" },
			{ name: "--step", required: false, description: "Step ID (single mode)" },
			{ name: "--goal", required: false, description: "Step goal (single mode)" },
			{ name: "--accept", required: false, description: "Accept criteria (repeatable)" },
			{ name: "--after", required: false, description: "Insert after this step ID" },
			{ name: "--stdin", required: false, description: "Read steps from stdin as YAML array (batch mode)" },
		],
	},
	"step start": {
		name: "step start",
		description: "Start working on a step",
		detail: "Sets step to in_progress. Session mapping is also updated (cross-session handoff).",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	"step done": {
		name: "step done",
		description: "Mark a step as done (PASS/FAIL)",
		detail: "PASS marks step done (requires verify if accept exists). FAIL records failure (step stays in_progress).",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
			{ name: "--result", required: true, description: "Result: PASS or FAIL", choices: ["PASS", "FAIL"] },
			{ name: "--message", required: true, description: "Result message" },
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	"step pause": {
		name: "step pause",
		description: "Pause task work and switch to dialogue mode",
		detail: "Pauses work for user dialogue. Stop hook is temporarily deactivated.",
		options: [
			{ name: "--message", required: true, description: "Reason for pausing" },
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	"step resume": {
		name: "step resume",
		description: "Resume task work from dialogue mode",
		detail: "Clears pause state and resumes work. Stop hook reactivated.",
		options: [
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	"step verify": {
		name: "step verify",
		description: "Record verification result for a step",
		detail: "Called by sub-agent. Independently verifies accept criteria. PASS enables step done (PASS).",
		options: [
			{ name: "--step", required: true, description: "Step ID" },
			{ name: "--result", required: true, description: "Result: PASS or FAIL", choices: ["PASS", "FAIL"] },
			{ name: "--message", required: true, description: "Verification message" },
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	status: {
		name: "status",
		description: "Show current task status",
		detail: "Outputs task goal, step progress, and suggested next actions in YAML.",
		options: [
			{ name: "--file", required: false, description: "Task file path" },
		],
	},
	check: {
		name: "check",
		description: "Stop hook gate check (reads session_id from stdin)",
		detail: "Auto-executed by Stop hook. Exit 2 (block) if incomplete, exit 0 (allow) otherwise.",
		options: [],
	},
	"session-start": {
		name: "session-start",
		description: "SessionStart hook handler (reads session_id from stdin)",
		detail: "Auto-executed by SessionStart hook. Sets session ID to HALTR_SESSION_ID env var.",
		options: [],
	},
};
