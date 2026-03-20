// ---- Accept types ----

export interface AcceptObject {
  id: string;
  check?: string;
  type?: "agent" | "human";
  instruction?: string;
  verifier?: string;
}

// ---- Step types ----

export type StepStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "blocked"
  | "skipped";

export interface Step {
  id: string;
  instructions: string;
  status?: StepStatus;
  accept?: string | AcceptObject[];
  agents?: {
    worker?: string;
    verifier?: string;
  };
  steps?: Step[];
}

// ---- Task types ----

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "pivoted";

export interface TaskAgents {
  worker: string;
  verifier: string;
}

// ---- History event types ----

interface HistoryEventBase {
  at: string;
  by: string;
}

export interface CreatedEvent extends HistoryEventBase {
  type: "created";
  message?: string;
}

export interface UpdatedEvent extends HistoryEventBase {
  type: "updated";
  diff?: string;
}

export interface StepStartedEvent extends HistoryEventBase {
  type: "step_started";
  step: string;
  attempt: number;
}

export interface WorkDoneEvent extends HistoryEventBase {
  type: "work_done";
  step: string;
  attempt: number;
  message?: string;
}

export interface VerifierStartedEvent extends HistoryEventBase {
  type: "verifier_started";
  step: string;
  attempt: number;
  accept_id: string;
}

export interface VerificationPassedEvent extends HistoryEventBase {
  type: "verification_passed";
  step: string;
  attempt: number;
  accept_id: string;
  message?: string;
}

export interface VerificationFailedEvent extends HistoryEventBase {
  type: "verification_failed";
  step: string;
  attempt: number;
  accept_id: string;
  message?: string;
}

export interface EscalationEvent extends HistoryEventBase {
  type: "escalation";
  step: string;
  attempt: number;
  message?: string;
}

export interface BlockedResolvedEvent extends HistoryEventBase {
  type: "blocked_resolved";
  step: string;
  attempt: number;
  message?: string;
}

export interface StepSkippedEvent extends HistoryEventBase {
  type: "step_skipped";
  step: string;
  message?: string;
}

export interface CompletedEvent extends HistoryEventBase {
  type: "completed";
  summary?: string;
}

export interface SpecReviewedEvent extends HistoryEventBase {
  type: "spec_reviewed";
  message?: string;
}

export interface ExecutionApprovedEvent extends HistoryEventBase {
  type: "execution_approved";
  message?: string;
}

export interface PivotedEvent extends HistoryEventBase {
  type: "pivoted";
  message?: string;
  next_task?: string;
}

export type HistoryEvent =
  | CreatedEvent
  | UpdatedEvent
  | StepStartedEvent
  | WorkDoneEvent
  | VerifierStartedEvent
  | VerificationPassedEvent
  | VerificationFailedEvent
  | EscalationEvent
  | BlockedResolvedEvent
  | StepSkippedEvent
  | CompletedEvent
  | SpecReviewedEvent
  | ExecutionApprovedEvent
  | PivotedEvent;

// ---- Task YAML root ----

export interface TaskYaml {
  id: string;
  status?: TaskStatus;
  previous?: string;
  agents: TaskAgents;
  steps: Step[];
  worker_session?: "shared" | "per-step";
  context?: string;
  history?: HistoryEvent[];
}

// ---- Config types ----

export interface ConfigYaml {
  orchestrator_cli: string;
  watcher: {
    poll_interval: number;
    inactivity_threshold: number;
  };
  panes: {
    max_concurrent: number;
  };
  retry: {
    max_attempts: number;
  };
  defaults?: {
    worker?: string;
    verifier?: string;
    worker_session?: "shared" | "per-step";
  };
}
