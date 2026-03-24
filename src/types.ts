// ---- Status types ----

/** Unified status type for both tasks and steps */
export type Status = "pending" | "in_progress" | "done" | "failed";

// ---- Step types ----

export interface Step {
	id: string;
	goal: string;
	status?: Status;
	accept?: string | string[];
	verified?: boolean;
}

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

export interface StepVerifiedEvent extends HistoryEventBase {
	type: "step_verified";
	step: string;
	result: "PASS" | "FAIL";
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
	| StepVerifiedEvent
	| PausedEvent
	| ResumedEvent
	| CompletedEvent
	| UserFeedbackEvent;

// ---- Task YAML root ----

export interface TaskYaml {
	id: string;
	goal: string;
	status?: Status;
	accept?: string | string[];
	plan?: string;
	context?: string;
	steps?: Step[];
	history?: HistoryEvent[];
}
