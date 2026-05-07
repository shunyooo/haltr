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
    /// Manage the critic quality gate
    Critic {
        #[command(subcommand)]
        command: CriticCommands,
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
}

#[derive(Subcommand)]
enum CriticCommands {
    /// Enable critic for the current session (or globally with --all)
    Enable {
        #[arg(long)]
        all: bool,
    },
    /// Disable critic for the current session (or globally with --all)
    Disable {
        #[arg(long)]
        all: bool,
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
        Commands::Critic { command } => match command {
            CriticCommands::Enable { all } => commands::critic::enable(all),
            CriticCommands::Disable { all } => commands::critic::disable(all),
        },
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
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
