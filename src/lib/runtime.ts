/**
 * Abstract Runtime interface for managing agent panes.
 *
 * Implementations can target tmux (TmuxRuntime) or other backends.
 */

export interface AgentInfo {
  /** Unique identifier (equals paneId for tmux). */
  agentId: string;
  /** Step path, e.g. "step-1". */
  step: string;
  /** Role: "worker", "verifier", "sub-orchestrator", "task-spec-reviewer", "rules-agent", "main-orchestrator". */
  role: string;
  /** tmux pane ID, e.g. "%3". */
  paneId: string;
  /** Parent orchestrator's pane ID. */
  parentPaneId: string;
  /** CLI to use: "claude", "codex", "gemini". */
  cli: string;
  /** Path to the task.yaml file. */
  taskPath: string;
}

export interface SpawnOptions {
  step: string;
  role: string;
  parentPaneId: string;
  cli: string;
  taskPath: string;
  /** Optional shell command to run in the new pane. */
  command?: string;
  /** Working directory for the new pane. */
  cwd?: string;
}

export interface Runtime {
  /** Spawn a new agent pane and return its info. */
  spawn(options: SpawnOptions): Promise<AgentInfo>;
  /** Kill an agent pane by agentId. */
  kill(agentId: string): Promise<void>;
  /** Send a message (text + Enter) to an agent pane. */
  send(agentId: string, message: string): Promise<void>;
  /** List all tracked agent panes. */
  list(): Promise<AgentInfo[]>;
  /** Check whether an agent pane is still alive. */
  isAlive(agentId: string): Promise<boolean>;
  /** Register a callback to be invoked when the agent's pane exits. */
  onExit(agentId: string, callback: () => void): void;
}
