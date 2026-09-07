//! Port of `vs/platform/shell/node/shellEnv.ts` — the login-shell environment.
//!
//! A GUI app on macOS and Linux is not started by a login shell, so it inherits
//! none of the user's `.profile` / `.zshrc` environment; the terminal needs it.
//! Stock's answer is to spawn the user's shell as a login shell, have it print
//! its environment between two copies of a random marker, and parse what comes
//! back between them.
//!
//! # Deliberate deviations from the reference implementation
//!
//! - **The payload is `env`, not `node -p`.** Stock prints
//!   `JSON.stringify(process.env)` by re-executing `process.execPath`, which is
//!   Electron running as Node. There is no JavaScript runtime here to re-execute,
//!   so the shell prints its environment with `env`. The consequence is the one
//!   `JSON.stringify` avoided: an environment value containing a newline is
//!   truncated at the newline.
//! - **No `--force-disable-user-env` / `--force-user-env` / `VSCODE_CLI`.** Those
//!   are CLI arguments to the desktop app, which this binary does not take. The
//!   `isWindows` skip is kept, and it is the one that matters.
//! - **The timeout is fixed at 10 s.** Stock reads
//!   `application.shellEnvironmentResolutionTimeout` from configuration, which
//!   lives in the frontend.

use std::time::Duration;

use tokio::sync::OnceCell;

use crate::powershell::is_powershell_name;
use crate::shell::get_system_shell;
use crate::types::{current_environment, node_basename, OperatingSystem, ProcessEnvironment};

/// Stock's default `application.shellEnvironmentResolutionTimeout`.
const MAX_SHELL_RESOLVE_TIME: Duration = Duration::from_secs(10);

/// Stock's `unixShellEnvPromise`: this spawns a process, so it runs once.
static UNIX_SHELL_ENV: OnceCell<ProcessEnvironment> = OnceCell::const_new();

/// Port of `getResolvedShellEnv`.
pub async fn get_resolved_shell_env() -> ProcessEnvironment {
    // Skip on windows
    if cfg!(windows) {
        log::trace!("resolveShellEnv(): skipped (Windows)");
        return ProcessEnvironment::new();
    }

    UNIX_SHELL_ENV
        .get_or_init(|| async {
            match tokio::time::timeout(MAX_SHELL_RESOLVE_TIME, resolve_unix_shell_env()).await {
                Ok(Some(env)) => env,
                Ok(None) => ProcessEnvironment::new(),
                Err(_) => {
                    log::warn!(
                        "Unable to resolve your shell environment in a reasonable time. \
                         Please review your shell configuration and restart."
                    );
                    ProcessEnvironment::new()
                }
            }
        })
        .await
        .clone()
}

/// Port of `doResolveUnixShellEnv`.
async fn resolve_unix_shell_env() -> Option<ProcessEnvironment> {
    let mark = marker();
    let env = current_environment();
    let shell = {
        let env = env.clone();
        tokio::task::spawn_blocking(move || get_system_shell(OperatingSystem::host(), &env))
            .await
            .ok()?
    };
    log::trace!("getUnixShellEnvironment#shell {shell}");

    let (shell_args, command) = shell_invocation(&shell, &mark);
    log::trace!("getUnixShellEnvironment#spawn {shell_args:?} {command}");

    let output = tokio::process::Command::new(&shell)
        .args(&shell_args)
        .arg(&command)
        .envs(&env)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        log::warn!(
            "Unexpected exit code from spawned shell (code {:?})",
            output.status.code()
        );
        return None;
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    Some(parse_marked_environment(&raw, &mark))
}

/// Port of the shell-name switch in `doResolveUnixShellEnv`, which picks the
/// login arguments per shell family. The payload differs (see the module docs);
/// which arguments make a given shell a *login, interactive* shell does not.
fn shell_invocation(shell: &str, mark: &str) -> (Vec<String>, String) {
    let name = node_basename(shell);
    let args = |values: &[&str]| values.iter().map(|value| (*value).to_owned()).collect();

    if is_powershell_name(&name) {
        return (
            args(&["-Login", "-Command"]),
            format!("Write-Output '{mark}'; & env; Write-Output '{mark}'"),
        );
    }
    if name == "xonsh" {
        // #200374: the native implementation is shorter.
        return (
            args(&["-i", "-l", "-c"]),
            format!(r#"import os; print("{mark}"); print("\n".join(f"{{k}}={{v}}" for k, v in os.environ.items())); print("{mark}")"#),
        );
    }
    let args = if name == "tcsh" || name == "csh" {
        args(&["-ic"])
    } else {
        args(&["-i", "-l", "-c"])
    };
    (args, format!("echo '{mark}'; env; echo '{mark}'"))
}

/// Everything between the two markers, one `KEY=value` per line.
fn parse_marked_environment(raw: &str, mark: &str) -> ProcessEnvironment {
    let Some(start) = raw.find(mark) else {
        return ProcessEnvironment::new();
    };
    let rest = &raw[start + mark.len()..];
    let body = rest.find(mark).map_or(rest, |end| &rest[..end]);

    body.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_owned(), value.to_owned()))
        // Stock deletes this one because it points at a directory that only
        // exists for the session that created it (microsoft/vscode#22593).
        .filter(|(key, _)| key != "XDG_RUNTIME_DIR")
        .collect()
}

/// Stock derives its marker from `generateUuid()`; all that matters is that the
/// shell's own startup output cannot contain it.
fn marker() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.subsec_nanos());
    format!("{:08x}{:04x}", nanos, std::process::id() & 0xFFFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_marked_section_is_read() {
        let raw = "welcome to your shell\nMARK\nFOO=1\nBAR=two words\nMARK\ntrailing noise\n";
        let env = parse_marked_environment(raw, "MARK");

        assert_eq!(env.get("FOO"), Some(&"1".to_owned()));
        assert_eq!(env.get("BAR"), Some(&"two words".to_owned()));
        assert!(!env.contains_key("welcome to your shell"));
        assert_eq!(env.len(), 2);
    }

    #[test]
    fn a_value_containing_an_equals_sign_is_kept_whole() {
        let env = parse_marked_environment("M\nA=b=c\nM", "M");
        assert_eq!(env.get("A"), Some(&"b=c".to_owned()));
    }

    #[test]
    fn the_session_only_runtime_dir_is_dropped() {
        // The marker has to be one the payload cannot contain — `M` alone is
        // inside `XDG_RUNTIME_DIR`, and the body would end at that letter.
        let env =
            parse_marked_environment("MARK\nXDG_RUNTIME_DIR=/run/user/0\nFOO=1\nMARK", "MARK");
        assert!(!env.contains_key("XDG_RUNTIME_DIR"));
        assert_eq!(env.len(), 1);
    }

    #[test]
    fn output_with_no_marker_yields_nothing() {
        assert!(parse_marked_environment("no marker here", "M").is_empty());
    }

    #[test]
    fn login_arguments_follow_the_shell_family() {
        assert_eq!(shell_invocation("/bin/zsh", "M").0, vec!["-i", "-l", "-c"]);
        assert_eq!(shell_invocation("/bin/csh", "M").0, vec!["-ic"]);
        assert_eq!(shell_invocation("/bin/tcsh", "M").0, vec!["-ic"]);
        assert_eq!(
            shell_invocation("/usr/bin/pwsh", "M").0,
            vec!["-Login", "-Command"]
        );
    }
}
