//! Port of `getWslPath` and `_getWSLExecutablePath` in
//! `vs/platform/terminal/node/ptyService.ts`, plus the Bash arm of
//! `escapeNonWindowsPath` in `vs/platform/terminal/common/terminalEnvironment.ts`
//! that the `win-to-unix` direction applies to `wslpath`'s answer.
//!
//! `escapeNonWindowsPath` is `common/` and is vendored into the frontend as
//! TypeScript; it is re-ported here because this is the only caller below
//! `ITerminalChildProcess`, and a `wslpath` result has to be escaped before it
//! is returned rather than after.

use std::path::Path;

use crate::windows_version::windows_build_number;

/// `wslpath` arrived in this Windows build.
const MINIMUM_WSLPATH_BUILD: u32 = 17063;
/// `wsl.exe` replaced `bash.exe` in this one.
const MINIMUM_WSL_EXE_BUILD: u32 = 16299;

/// The direction stock's `getWslPath(original, direction)` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WslDirection {
    UnixToWin,
    WinToUnix,
}

/// Port of `getWslPath`.
pub async fn get_wsl_path(original: &str, direction: WslDirection) -> String {
    if !cfg!(windows) {
        return original.to_owned();
    }

    match direction {
        WslDirection::WinToUnix => {
            if windows_build_number() < MINIMUM_WSLPATH_BUILD {
                return original.replace('\\', "/");
            }
            let Some(wsl) = wsl_executable_path() else {
                return original.to_owned();
            };
            match run_wslpath(&wsl, &["-e", "wslpath", original]).await {
                Some(path) => escape_non_windows_path(&path),
                None => original.to_owned(),
            }
        }
        WslDirection::UnixToWin => {
            // The backend is Windows, for example a local Windows workspace with
            // a wsl session in the terminal.
            if windows_build_number() < MINIMUM_WSLPATH_BUILD {
                return original.to_owned();
            }
            let Some(wsl) = wsl_executable_path() else {
                return original.to_owned();
            };
            run_wslpath(&wsl, &["-e", "wslpath", "-w", original])
                .await
                .unwrap_or_else(|| original.to_owned())
        }
    }
}

async fn run_wslpath(executable: &Path, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new(executable);
    command.args(args).stdin(std::process::Stdio::null());
    let output = tscode_proc::hide_console(&mut command).output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Port of `_getWSLExecutablePath`.
fn wsl_executable_path() -> Option<std::path::PathBuf> {
    let use_wsl_exe = windows_build_number() >= MINIMUM_WSL_EXE_BUILD;
    let is_32_process_on_64_windows = std::env::var_os("PROCESSOR_ARCHITEW6432").is_some();
    let system_root = std::env::var_os("SystemRoot")?;

    Some(
        Path::new(&system_root)
            .join(if is_32_process_on_64_windows {
                "Sysnative"
            } else {
                "System32"
            })
            .join(if use_wsl_exe { "wsl.exe" } else { "bash.exe" }),
    )
}

/// Port of `escapeNonWindowsPath(path, PosixShellType.Bash)`, which is the only
/// shell type `getWslPath` passes.
///
/// Aggressively escapes the path to prepare it for being sent to a shell, some
/// of it inaccurately, to be careful about script injection via the file path —
/// the attack being prevented is `/foo/file$(echo evil)`.
pub fn escape_non_windows_path(path: &str) -> String {
    let mut new_path = path.to_owned();
    if new_path.contains('\\') {
        new_path = new_path.replace('\\', r"\\");
    }

    // Remove dangerous characters except single and double quotes, which are
    // escaped properly below.
    new_path.retain(|character| !"`$|&>~#!^*;<".contains(character));

    let has_single = new_path.contains('\'');
    let has_double = new_path.contains('"');
    if has_single && has_double {
        format!("$'{}'", new_path.replace('\'', r"\'"))
    } else if has_single {
        format!("'{}'", new_path.replace('\'', r"\'"))
    } else {
        format!("'{new_path}'")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_path_is_single_quoted() {
        assert_eq!(escape_non_windows_path("/mnt/c/work"), "'/mnt/c/work'");
    }

    #[test]
    fn backslashes_are_doubled_before_anything_else() {
        assert_eq!(escape_non_windows_path(r"/a\b"), r"'/a\\b'");
    }

    #[test]
    fn injection_characters_are_removed_rather_than_escaped() {
        assert_eq!(
            escape_non_windows_path("/foo/file$(echo evil)"),
            "'/foo/file(echo evil)'"
        );
        assert_eq!(escape_non_windows_path("/a`b|c;d"), "'/abcd'");
    }

    #[test]
    fn a_single_quote_is_escaped_inside_the_quotes() {
        assert_eq!(escape_non_windows_path("/a'b"), r"'/a\'b'");
    }

    #[test]
    fn both_quote_kinds_use_the_dollar_form() {
        assert_eq!(escape_non_windows_path("/a'b\"c"), "$'/a\\'b\"c'");
    }

    #[test]
    fn the_direction_deserializes_from_its_wire_spelling() {
        assert_eq!(
            serde_json::from_str::<WslDirection>("\"win-to-unix\"").unwrap(),
            WslDirection::WinToUnix
        );
        assert_eq!(
            serde_json::from_str::<WslDirection>("\"unix-to-win\"").unwrap(),
            WslDirection::UnixToWin
        );
    }
}
