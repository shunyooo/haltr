mod commands;
mod core;
mod types;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "hal", version, about = "haltr — Quality assurance tool for coding agent outputs",
    after_help = r#"What is haltr?
  A tool that helps coding agents complete long-running tasks with quality.
  Persists goals, steps, and history in task.yaml. Uses quality gates and
  Stop hook to prevent forgetting, cutting corners, and premature exit.

When to use:
  Use for multi-step work (implementation + tests + docs, etc.).
  Not needed for simple questions or small fixes.
  Create a task with hal task create when you judge "this will take a while".

How task.yaml works:
  task.yaml is the state management file. It persists:
  - goal: what to achieve
  - steps: list of steps and their status (pending -> in_progress -> done/failed)
  - history: full event log (created, step_started, step_done, paused, etc.)
  Even as context grows long, hal status gives an accurate view of current state.

Accept criteria & verification:
  accept defines step completion criteria. When set, a quality gate is enforced:
  1. hal step add --step impl --goal 'Implement' --accept 'Tests pass'
  2. Do the work
  3. Spawn a sub-agent with the Agent tool to independently verify accept criteria
  4. Sub-agent runs hal step verify --step impl --result PASS|FAIL
  5. After verify PASS, run hal step done --step impl --result PASS
  Steps without accept can be marked done directly (no verify needed).

Stop hook:
  After hal step start, the agent is blocked from stopping until the task completes.
  Use hal step pause to temporarily unblock for user dialogue.

Workflow:
  1. hal setup                                          One-time. Register hooks
  2. hal task create --file <name> --goal '<goal>'       Create task
  3. hal step add --step <id> --goal '<goal>'            Break into steps
  4. hal step start --step <id>                          Start work (Stop hook active)
  5. Work -> verify -> hal step done --step <id> --result PASS|FAIL
  6. All steps done -> task auto-completes -> Stop hook deactivated

Step lifecycle:
  hal step start   Set step to in_progress. Stop hook activated
  hal step verify  Record verification result via sub-agent (when accept exists)
  hal step done    Mark step complete (PASS) or record failure (FAIL)
  hal step pause   Switch to dialogue mode (Stop hook temporarily deactivated)
  hal step resume  Return to autonomous mode (Stop hook reactivated)

Task file resolution (when --file omitted):
  1. Session mapping (auto-registered on task create / step start)
  2. Auto-detect task.yaml or *.task.yaml in current directory"#)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Register haltr hooks in ~/.claude/settings.json
    Setup,
    /// Manage tasks (create, edit)
    Task {
        #[command(subcommand)]
        command: TaskCommands,
    },
    /// Manage steps (add, start, done, pause, resume, verify)
    Step {
        #[command(subcommand)]
        command: StepCommands,
    },
    /// Show current task status
    Status {
        #[arg(long)]
        file: Option<String>,
    },
    /// Stop hook gate check (reads session_id from stdin)
    Check,
    /// SessionStart hook handler (reads session_id from stdin)
    SessionStart,
}

#[derive(Subcommand)]
enum TaskCommands {
    /// Create a new task file
    Create {
        #[arg(long)]
        file: String,
        #[arg(long)]
        goal: String,
        #[arg(long)]
        accept: Vec<String>,
        #[arg(long)]
        plan: Option<String>,
    },
    /// Edit the current task
    Edit {
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        goal: Option<String>,
        #[arg(long)]
        accept: Vec<String>,
        #[arg(long)]
        plan: Option<String>,
        #[arg(long)]
        message: String,
    },
}

#[derive(Subcommand)]
enum StepCommands {
    /// Add a new step to the task
    Add {
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        step: Option<String>,
        #[arg(long)]
        goal: Option<String>,
        #[arg(long)]
        accept: Vec<String>,
        #[arg(long, name = "after")]
        after_step: Option<String>,
        #[arg(long)]
        stdin: bool,
    },
    /// Start working on a step (activates Stop hook)
    Start {
        #[arg(long)]
        step: String,
        #[arg(long)]
        file: Option<String>,
    },
    /// Mark a step as done (PASS/FAIL)
    Done {
        #[arg(long)]
        step: String,
        #[arg(long)]
        result: String,
        #[arg(long)]
        message: String,
        #[arg(long)]
        file: Option<String>,
    },
    /// Pause task work and switch to dialogue mode
    Pause {
        #[arg(long)]
        message: String,
        #[arg(long)]
        file: Option<String>,
    },
    /// Resume task work from dialogue mode
    Resume {
        #[arg(long)]
        file: Option<String>,
    },
    /// Record verification result for a step (called by sub-agent)
    Verify {
        #[arg(long)]
        step: String,
        #[arg(long)]
        result: String,
        #[arg(long)]
        message: String,
        #[arg(long)]
        file: Option<String>,
    },
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Setup => commands::setup::handle_setup(),
        Commands::Task { command } => match command {
            TaskCommands::Create { file, goal, accept, plan } => {
                commands::task::handle_task_create(&file, &goal, &accept, plan.as_deref())
            }
            TaskCommands::Edit { file, goal, accept, plan, message } => {
                commands::task::handle_task_edit(file.as_deref(), goal.as_deref(), &accept, plan.as_deref(), &message)
            }
        },
        Commands::Step { command } => match command {
            StepCommands::Add { file, step, goal, accept, after_step, stdin } => {
                if stdin {
                    commands::step::handle_step_add_batch(file.as_deref())
                } else {
                    match (step, goal) {
                        (Some(s), Some(g)) => commands::step::handle_step_add(file.as_deref(), &s, &g, &accept, after_step.as_deref()),
                        _ => Err(anyhow::anyhow!("Specify --step and --goal, or use --stdin for batch mode")),
                    }
                }
            }
            StepCommands::Start { step, file } => {
                commands::step::handle_step_start(file.as_deref(), &step)
            }
            StepCommands::Done { step, result, message, file } => {
                commands::step::handle_step_done(file.as_deref(), &step, &result, &message)
            }
            StepCommands::Pause { message, file } => {
                commands::step::handle_step_pause(file.as_deref(), &message)
            }
            StepCommands::Resume { file } => {
                commands::step::handle_step_resume(file.as_deref())
            }
            StepCommands::Verify { step, result, message, file } => {
                commands::step::handle_step_verify(file.as_deref(), &step, &result, &message)
            }
        },
        Commands::Status { file } => {
            commands::status::handle_status(file.as_deref())
        }
        Commands::Check => {
            commands::check::handle_check();
            Ok(())
        }
        Commands::SessionStart => {
            commands::session::handle_session_start();
            Ok(())
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
