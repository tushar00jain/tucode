//! Port of `vs/base/node/processes.ts` — `findExecutable` and
//! `getWindowsShell`.
//!
//! `killTree` and `createQueuedSender` are not ported: nothing below
//! `ITerminalChildProcess` calls them. `freePortKillProcess`, the only caller of
//! `killTree` in the terminal, is dropped by the architecture doc's cut table.
//!
//! Blocking: touches the filesystem. Callers run it inside `spawn_blocking`.

use std::path::{Path, PathBuf};

use crate::types::{
    get_case_insensitive, node_dirname, ProcessEnvironment, PATH_DELIMITER,
};

/// Port of `getWindowsShell`.
pub fn get_windows_shell(env: &ProcessEnvironment) -> String {
    env.get("comspec")
        .cloned()
        .unwrap_or_else(|| "cmd.exe".to_owned())
}

/// Stock's injectable `fileExists`. `terminalProfiles.ts` substitutes its
/// `IFsProvider.existsFile` here, and so do the ported upstream tests.
pub type FileExists<'a> = &'a dyn Fn(&Path) -> bool;

/// Port of `fileExistsDefault`: exists, and is not a directory. Stock retries
/// with `lstat` on `EACCES` because the entry may be a symlink;
/// [`std::fs::symlink_metadata`] is that retry.
pub fn file_exists_default(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => !meta.is_dir(),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_dir())
        }
        Err(_) => false,
    }
}

/// Port of `findExecutable(command, cwd?, paths?, env?, fileExists?)`.
///
/// Returns the absolute path the shell will actually run, which
/// `TerminalProcess._validateExecutable` writes back into the launch config so
/// the pty does not search `PATH` a second time.
pub fn find_executable(
    command: &str,
    cwd: Option<&Path>,
    paths: Option<&[String]>,
    env: Option<&ProcessEnvironment>,
    file_exists: FileExists<'_>,
) -> Option<PathBuf> {
    // If we have an absolute path then we take it.
    if Path::new(command).is_absolute() {
        return exists_or_none(PathBuf::from(command), file_exists);
    }

    let owned_cwd;
    let cwd = match cwd {
        Some(cwd) => cwd,
        None => {
            owned_cwd = std::env::current_dir().ok()?;
            &owned_cwd
        }
    };

    // We have a directory and the directory is relative (see above). Make the
    // path absolute to the current working directory.
    if node_dirname(command) != "." {
        return exists_or_none(cwd.join(command), file_exists);
    }

    let default_env;
    let env = match env {
        Some(env) => env,
        None => {
            default_env = crate::types::current_environment();
            &default_env
        }
    };

    let from_env: Vec<String>;
    let paths = match paths {
        Some(paths) => paths,
        None => match get_case_insensitive(env, "PATH") {
            Some(value) => {
                from_env = value.split(PATH_DELIMITER).map(str::to_owned).collect();
                from_env.as_slice()
            }
            // No PATH environment. Make path absolute to the cwd.
            None => return exists_or_none(cwd.join(command), file_exists),
        },
    };
    if paths.is_empty() {
        return exists_or_none(cwd.join(command), file_exists);
    }

    // We have a simple file name. We get the path variable from the env and try
    // to find the executable on the path.
    for entry in paths {
        let entry_path = Path::new(entry);
        let full_path = if entry_path.is_absolute() {
            entry_path.join(command)
        } else {
            cwd.join(entry_path).join(command)
        };

        if cfg!(windows) {
            let path_ext = get_case_insensitive(env, "PATHEXT")
                .cloned()
                .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_owned());
            for extension in path_ext.split(';') {
                let with_extension = append_extension(&full_path, extension);
                if file_exists(&with_extension) {
                    return Some(with_extension);
                }
            }
        }

        if file_exists(&full_path) {
            return Some(full_path);
        }
    }

    exists_or_none(cwd.join(command), file_exists)
}

/// Stock appends the extension to the *string*, so `git.exe` stays `git.exe` and
/// `git` becomes `git.exe`; `Path::set_extension` would replace instead.
fn append_extension(path: &Path, extension: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(extension);
    PathBuf::from(value)
}

fn exists_or_none(path: PathBuf, file_exists: FileExists<'_>) -> Option<PathBuf> {
    file_exists(&path).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exists_only(known: &[&str]) -> impl Fn(&Path) -> bool {
        let known: Vec<PathBuf> = known.iter().map(PathBuf::from).collect();
        move |path: &Path| known.iter().any(|candidate| candidate == path)
    }

    #[test]
    fn an_absolute_command_is_taken_as_is() {
        let absolute = if cfg!(windows) { r"C:\bin\zsh" } else { "/bin/zsh" };
        let exists = exists_only(&[absolute]);

        assert_eq!(
            find_executable(absolute, None, None, None, &exists),
            Some(PathBuf::from(absolute))
        );
        let missing = if cfg!(windows) { r"C:\bin\nope" } else { "/bin/nope" };
        assert_eq!(find_executable(missing, None, None, None, &exists), None);
    }

    #[test]
    fn a_relative_directory_resolves_against_the_cwd() {
        let cwd = Path::new(if cfg!(windows) { r"C:\work" } else { "/work" });
        let expected = cwd.join("bin/sh");
        let expected_str = expected.to_string_lossy().into_owned();
        let exists = exists_only(&[&expected_str]);

        assert_eq!(
            find_executable("bin/sh", Some(cwd), None, None, &exists),
            Some(expected)
        );
    }

    #[test]
    fn a_bare_name_is_searched_on_the_given_paths() {
        let dir = if cfg!(windows) { r"C:\usr\bin" } else { "/usr/bin" };
        let other = if cfg!(windows) { r"C:\opt\bin" } else { "/opt/bin" };
        let expected = Path::new(dir).join("fakeshell");
        let expected_str = expected.to_string_lossy().into_owned();
        let exists = exists_only(&[&expected_str]);

        let paths = vec![other.to_owned(), dir.to_owned()];
        assert_eq!(
            find_executable("fakeshell", Some(Path::new(dir)), Some(&paths), None, &exists),
            Some(expected)
        );
    }

    #[test]
    fn a_name_found_on_no_path_entry_is_none() {
        let dir = if cfg!(windows) { r"C:\usr\bin" } else { "/usr/bin" };
        let exists = exists_only(&[]);
        let paths = vec![dir.to_owned()];

        assert_eq!(
            find_executable("fakeshell", Some(Path::new(dir)), Some(&paths), None, &exists),
            None
        );
    }

    #[test]
    fn comspec_wins_over_the_cmd_default() {
        let mut env = ProcessEnvironment::new();
        assert_eq!(get_windows_shell(&env), "cmd.exe");
        env.insert("comspec".to_owned(), r"C:\Windows\System32\cmd.exe".to_owned());
        assert_eq!(get_windows_shell(&env), r"C:\Windows\System32\cmd.exe");
    }
}
