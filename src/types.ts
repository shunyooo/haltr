// ---- Accept types (v2) ----

// In v2, accept is a simple string or string array — no AcceptObject needed.

// ---- Step types ----

export type StepStatus = "pending" | "in_progress" | "done" | "failed";

export interface Step {
	id: string;
	goal: string;
	status?: StepStatus;
	accept?: string | string[];
}

// ---- Task types ----

export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

// ---- History event types ----

interface HistoryEventBase {
	at: string;
}

export interface CreatedEvent extends HistoryEventBase {
	type: "created";
	message?: string;
}

export interface UpdatedEvent extends HistoryEventBase {
	type: "updated";
	message?: string;
}

export interface StepAddedEvent extends HistoryEventBase {
	type: "step_added";
	step: string;
	message?: string;
}

export interface StepStartedEvent extends HistoryEventBase {
	type: "step_started";
	step: string;
	message?: string;
}

export interface StepDoneEvent extends HistoryEventBase {
	type: "step_done";
	step: string;
	message?: string;
}

export interface StepFailedEvent extends HistoryEventBase {
	type: "step_failed";
	step: string;
	message?: string;
}

export interface PausedEvent extends HistoryEventBase {
	type: "paused";
	message?: string;
}

export interface ResumedEvent extends HistoryEventBase {
	type: "resumed";
	message?: string;
}

export interface CompletedEvent extends HistoryEventBase {
	type: "completed";
	message?: string;
}

export interface UserFeedbackEvent extends HistoryEventBase {
	type: "user_feedback";
	message?: string;
}

export type HistoryEvent =
	| CreatedEvent
	| UpdatedEvent
	| StepAddedEvent
	| StepStartedEvent
	| StepDoneEvent
	| StepFailedEvent
	| PausedEvent
	| ResumedEvent
	| CompletedEvent
	| UserFeedbackEvent;

// ---- Task YAML root ----

export interface TaskYaml {
	id: string;
	goal: string;
	status?: TaskStatus;
	accept?: string | string[];
	plan?: string;
	notes?: string;
	context?: string;
	steps?: Step[];
	history?: HistoryEvent[];
}

// ---- Config types ----

export interface ConfigYaml {
	timezone?: string;
	haltr_dir?: string;
}
