mod commands;
mod hook;
mod memory_stats;
mod session;
mod transcript;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "hal", version, about = "haltr — Stop hook quality gate + learning pipeline for coding agents")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize .haltr/ directory and register Stop hook in .claude/settings.json
    Setup,
    /// Enable the haltr Stop hook for the current session (or globally with --all)
    Enable {
        #[arg(long)]
        all: bool,
    },
    /// Disable the haltr Stop hook for the current session (or globally with --all)
    Disable {
        #[arg(long)]
        all: bool,
    },
    /// Stop hook entrypoint (called by Claude Code, not by users)
    Hook {
        #[command(subcommand)]
        command: HookCommands,
    },
    /// Inspect memory entry usage statistics
    Memory {
        #[command(subcommand)]
        command: MemoryCommands,
    },
    /// Emit migration hints for the calling agent to bring `.haltr/` up to date
    Migrate {
        #[command(subcommand)]
        command: MigrateCommands,
    },
    /// Tail and pretty-print the session log (defaults to newest in .haltr/logs/)
    Watch {
        /// Session ID or prefix. Defaults to the most recently modified log.
        session: Option<String>,
        /// Read once and exit instead of tailing
        #[arg(long)]
        no_follow: bool,
    },
}

#[derive(Subcommand)]
enum HookCommands {
    /// Stop hook handler: quality gate + learning pipeline
    Stop,
}

#[derive(Subcommand)]
enum MemoryCommands {
    /// Show per-entry check / hit counts and last-hit timestamps
    Stats,
    /// Show the individual hit events for a memory entry, scanned from logs
    Hits {
        /// Entry filename, e.g. `260506-1959-no-primary-content-crowding.md`
        entry: String,
    },
}

#[derive(Subcommand)]
enum MigrateCommands {
    /// Emit a markdown migration brief for the calling agent (current contracts + bundled agent files)
    Hint,
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Setup => commands::setup::run(),
        Commands::Enable { all } => commands::toggle::enable(all),
        Commands::Disable { all } => commands::toggle::disable(all),
        Commands::Hook { command } => match command {
            HookCommands::Stop => hook::stop::run(),
        },
        Commands::Memory { command } => match command {
            MemoryCommands::Stats => commands::memory::stats(),
            MemoryCommands::Hits { entry } => commands::memory::hits(&entry),
        },
        Commands::Migrate { command } => match command {
            MigrateCommands::Hint => commands::migrate::hint(),
        },
        Commands::Watch { session, no_follow } => commands::watch::run(session, no_follow),
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
