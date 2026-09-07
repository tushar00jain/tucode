//! Port of `vs/base/node/shell.ts` — `getSystemShell`.
//!
//! This is the *system's* default shell, not the terminal's configured default;
//! the frontend resolves the latter from the profile list.
//!
//! Blocking on Windows: the first call enumerates PowerShell installations.
//! Callers run it inside `spawn_blocking`.

use std::sync::Mutex;

use crate::powershell::first_available_powershell_installation;
use crate::processes::get_windows_shell;
use crate::types::{OperatingSystem, ProcessEnvironment};

/// Stock's `_TERMINAL_DEFAULT_SHELL_UNIX_LIKE` module-level cache. Spawning a
/// shell to read `/etc/passwd` is not free and the answer cannot change while
/// the process runs.
static UNIX_LIKE_SHELL: Mutex<Option<String>> = Mutex::new(None);
/// Stock's `_TERMINAL_DEFAULT_SHELL_WINDOWS`.
static WINDOWS_SHELL: Mutex<Option<String>> = Mutex::new(None);

/// Port of `getSystemShell(os, env)`.
pub fn get_system_shell(os: OperatingSystem, env: &ProcessEnvironment) -> String {
    if os == OperatingSystem::Windows {
        if cfg!(windows) {
            return get_system_shell_windows();
        }
        // Don't detect Windows shell when not on Windows
        return get_windows_shell(env);
    }

    get_system_shell_unix_like(os, env)
}

/// Port of `getSystemShellUnixLike`.
fn get_system_shell_unix_like(os: OperatingSystem, env: &ProcessEnvironment) -> String {
    // Only use $SHELL for the current OS
    let host = OperatingSystem::host();
    if host == OperatingSystem::Linux && os == OperatingSystem::Macintosh
        || host == OperatingSystem::Macintosh && os == OperatingSystem::Linux
    {
        return "/bin/bash".to_owned();
    }

    let mut cached = UNIX_LIKE_SHELL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(shell) = cached.as_ref() {
        return shell.clone();
    }

    let shell = if cfg!(windows) {
        "/bin/bash".to_owned() // for WSL
    } else {
        let mut shell = env.get("SHELL").cloned().filter(|value| !value.is_empty());

        if shell.is_none() {
            // It's possible for $SHELL to be unset, this reads /etc/passwd.
            shell = passwd_shell();
        }

        let mut shell = shell.unwrap_or_else(|| "sh".to_owned());

        // Some systems have $SHELL set to /bin/false which breaks the terminal
        if shell == "/bin/false" {
            shell = "/bin/bash".to_owned();
        }
        shell
    };

    *cached = Some(shell.clone());
    shell
}

/// Stock's `userInfo().shell`, which is `getpwuid` on the current uid. This
/// reads the same database by user name, since resolving the uid would need an
/// `unsafe` libc call for the one branch that only fires when `$SHELL` is unset.
#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).ok()?;
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    passwd.lines().find_map(|line| {
        // name:passwd:uid:gid:gecos:dir:shell
        let mut fields = line.split(':');
        if fields.next()? != user {
            return None;
        }
        fields.nth(5).filter(|shell| !shell.is_empty()).map(str::to_owned)
    })
}

#[cfg(not(unix))]
fn passwd_shell() -> Option<String> {
    None
}

/// Port of `getSystemShellWindows`.
fn get_system_shell_windows() -> String {
    let mut cached = WINDOWS_SHELL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(shell) = cached.as_ref() {
        return shell.clone();
    }

    // Stock dereferences the result with `!`: on Windows, `findWinPS` is always
    // in the candidate list and is constructed `knownToExist`.
    let shell = first_available_powershell_installation()
        .map(|pwsh| pwsh.exe_path.to_string_lossy().into_owned())
        .unwrap_or_else(|| get_windows_shell(&crate::types::current_environment()));

    *cached = Some(shell.clone());
    shell
}
