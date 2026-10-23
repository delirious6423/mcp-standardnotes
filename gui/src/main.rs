#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use std::process::ExitCode;

fn main() -> ExitCode {
    // Fixed ERROR-level diagnostics only; never honor verbose logging environment overrides.
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .with_target(false)
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let operation = match standardnotes_connection::approval_argument(&args) {
        Ok(operation) => operation,
        Err(message) => {
            tracing::error!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let approval_mode = operation.is_some();
    match standardnotes_connection::ui::run(operation) {
        Some(approved) if !approval_mode || approved => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}
