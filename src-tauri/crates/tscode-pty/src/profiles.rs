//! Port of `vs/platform/terminal/node/terminalProfiles.ts` —
//! `detectAvailableProfiles`.
//!
//! Profile detection is a table of candidates crossed with the filesystem: the
//! Windows table names PowerShell, Windows PowerShell, Git Bash, Command Prompt,
//! Cygwin, MSYS2 and Cmder; the Unix one reads `/etc/shells`. User settings are
//! then applied over the table, and every surviving candidate is validated —
//! first path that exists wins, and a bare name is looked up on `$PATH` with
//! [`find_executable`].
//!
//! # Deliberate deviations from the reference implementation
//!
//! - **No `IConfigurationService`.** Stock falls back to
//!   `terminal.integrated.profiles.*` and `defaultProfile.*` when the caller
//!   passes neither; the frontend owns configuration here and always passes
//!   both. `useWslProfiles` arrives as a parameter for the same reason.
//! - **No `variableResolver`.** Stock resolves `${env:…}` in configured profile
//!   paths through the workbench's variable resolver, which lives in the
//!   frontend. Paths arrive already resolved.
//! - **No extension-contributed profiles.** There is no extension host.
//! - **`path.normalize` is not applied before the existence check.** Every path
//!   the detection table builds is already normal, and a configured path is
//!   checked as the user wrote it.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::powershell::enumerate_powershell_installations;
use crate::processes::{file_exists_default, find_executable};
use crate::types::{
    node_basename, ProcessEnvironment, ProfilePath, ProfileSource, SingleOrMany, TerminalProfile,
    ThemeIcon, UnresolvedTerminalProfile, PATH_DELIMITER,
};
use crate::windows_version::windows_build_number;

const UNIX_SHELLS_PATH: &str = "/etc/shells";
/// WSL 2 released in the May 2020 Update, which is where the `-d` flag we depend
/// on was added.
const MINIMUM_WSL_BUILD: u32 = 19041;
/// Stock's `cp.exec(..., { timeout: 1000 })` on `wsl.exe -l -q`.
const WSL_LIST_TIMEOUT: Duration = Duration::from_millis(1000);

/// Stock's `IFsProvider`, which the upstream tests substitute to drive detection
/// against a fixture filesystem rather than the machine's.
pub trait FsProvider: Send + Sync {
    fn exists_file(&self, path: &Path) -> bool;
    fn read_file(&self, path: &Path) -> Option<Vec<u8>>;
}

/// The real filesystem — stock's `{ existsFile: SymlinkSupport.existsFile,
/// readFile: fs.promises.readFile }`.
pub struct DiskFsProvider;

impl FsProvider for DiskFsProvider {
    fn exists_file(&self, path: &Path) -> bool {
        file_exists_default(path)
    }

    fn read_file(&self, path: &Path) -> Option<Vec<u8>> {
        std::fs::read(path).ok()
    }
}

/// Stock's `IPotentialTerminalProfile`.
struct PotentialTerminalProfile {
    paths: Vec<String>,
    args: Option<Vec<String>>,
    icon: Option<ThemeIcon>,
}

/// Stock's module-level `profileSources` cache: the discovered Git Bash and
/// PowerShell paths, which are the same for every profile that sources them.
static PROFILE_SOURCES: Mutex<Option<Vec<(ProfileSource, Vec<String>)>>> = Mutex::new(None);

/// The arguments `detectAvailableProfiles` takes, minus the services.
pub struct DetectOptions {
    /// A `None` value is stock's `null` profile, which deletes a detected one.
    pub profiles: BTreeMap<String, Option<UnresolvedTerminalProfile>>,
    pub default_profile: Option<String>,
    pub include_detected_profiles: bool,
    /// Stock's `terminal.integrated.useWslProfiles`, which defaults on.
    pub use_wsl_profiles: bool,
    pub shell_env: ProcessEnvironment,
    /// Stock's `testPwshSourcePaths`, which the upstream tests use to pin the
    /// PowerShell candidates.
    pub test_pwsh_source_paths: Option<Vec<String>>,
}

/// Port of `detectAvailableProfiles`.
///
/// The filesystem half runs inside `spawn_blocking`; WSL enumeration is a child
/// process and stays on the runtime so stock's one-second timeout is expressible.
pub async fn detect_available_profiles(
    options: DetectOptions,
    fs: Arc<dyn FsProvider>,
) -> Vec<TerminalProfile> {
    let allow_wsl_discovery = cfg!(windows)
        && options.include_detected_profiles
        && options.use_wsl_profiles
        && windows_build_number() >= MINIMUM_WSL_BUILD;
    let configured_names: Vec<String> = options.profiles.keys().cloned().collect();
    let default_profile = options.default_profile.clone();

    let Ok(mut profiles) =
        tokio::task::spawn_blocking(move || detect_blocking(&options, fs.as_ref())).await
    else {
        return Vec::new();
    };

    if allow_wsl_discovery {
        match wsl_profiles(&system32_path(), default_profile.as_deref()).await {
            Ok(found) => profiles.extend(
                found
                    .into_iter()
                    .filter(|profile| !configured_names.contains(&profile.profile_name)),
            ),
            Err(error) => {
                log::trace!("WSL is not installed, so could not detect WSL profiles: {error}");
            }
        }
    }

    profiles
}

/// Port of `detectAvailableWindowsProfiles` / `detectAvailableUnixProfiles`,
/// less the WSL enumeration.
pub fn detect_blocking(
    options: &DetectOptions,
    fs: &dyn FsProvider,
) -> Vec<TerminalProfile> {
    let mut detected: BTreeMap<String, UnresolvedTerminalProfile> = BTreeMap::new();

    if cfg!(windows) {
        initialize_windows_profiles(options.test_pwsh_source_paths.clone());
        if options.include_detected_profiles {
            add_windows_detected_profiles(&mut detected);
        }
    } else if options.include_detected_profiles && fs.exists_file(Path::new(UNIX_SHELLS_PATH)) {
        add_unix_detected_profiles(&mut detected, fs);
    }

    apply_config_profiles_to_map(&options.profiles, &mut detected);

    detected
        .into_iter()
        .filter_map(|(profile_name, profile)| {
            get_validated_profile(&profile_name, &profile, options, fs)
        })
        .collect()
}

/// Port of the Windows half of `detectAvailableWindowsProfiles`' detected table.
fn add_windows_detected_profiles(detected: &mut BTreeMap<String, UnresolvedTerminalProfile>) {
    let system32 = system32_path();
    let home_drive = std::env::var("HOMEDRIVE").unwrap_or_default();

    detected.insert(
        "PowerShell".to_owned(),
        UnresolvedTerminalProfile {
            source: Some(ProfileSource::Pwsh),
            icon: Some(ThemeIcon::new("terminal-powershell")),
            is_auto_detected: Some(true),
            ..UnresolvedTerminalProfile::default()
        },
    );
    detected.insert(
        "Windows PowerShell".to_owned(),
        UnresolvedTerminalProfile {
            path: Some(SingleOrMany::One(ProfilePath::Plain(format!(
                r"{system32}\WindowsPowerShell\v1.0\powershell.exe"
            )))),
            icon: Some(ThemeIcon::new("terminal-powershell")),
            is_auto_detected: Some(true),
            ..UnresolvedTerminalProfile::default()
        },
    );
    detected.insert(
        "Git Bash".to_owned(),
        UnresolvedTerminalProfile {
            source: Some(ProfileSource::GitBash),
            icon: Some(ThemeIcon::new("terminal-git-bash")),
            is_auto_detected: Some(true),
            ..UnresolvedTerminalProfile::default()
        },
    );
    detected.insert(
        "Command Prompt".to_owned(),
        UnresolvedTerminalProfile {
            path: Some(SingleOrMany::One(ProfilePath::Plain(format!(r"{system32}\cmd.exe")))),
            icon: Some(ThemeIcon::new("terminal-cmd")),
            is_auto_detected: Some(true),
            ..UnresolvedTerminalProfile::default()
        },
    );
    detected.insert(
        "Cygwin".to_owned(),
        UnresolvedTerminalProfile {
            path: Some(SingleOrMany::Many(vec![
                ProfilePath::unsafe_path(format!(r"{home_drive}\cygwin64\bin\bash.exe")),
                ProfilePath::unsafe_path(format!(r"{home_drive}\cygwin\bin\bash.exe")),
            ])),
            args: Some(SingleOrMany::Many(vec!["--login".to_owned()])),
            is_auto_detected: Some(true),
            ..UnresolvedTerminalProfile::default()
        },
    );
    detected.insert(
        "bash (MSYS2)".to_owned(),
        UnresolvedTerminalProfile {
            path: Some(SingleOrMany::Many(vec![ProfilePath::unsafe_path(format!(
                r"{home_drive}\msys64\usr\bin\bash.exe"
            ))])),
            args: Some(SingleOrMany::Many(vec![
                "--login".to_owned(),
                "-i".to_owned(),
            ])),
            // CHERE_INVOKING retains current working directory
            env: Some([("CHERE_INVOKING".to_owned(), Some("1".to_owned()))].into()),
            icon: Some(ThemeIcon::new("terminal-bash")),
            is_auto_detected: Some(true),
            ..UnresolvedTerminalProfile::default()
        },
    );
    let cmder_root = std::env::var("CMDER_ROOT").ok();
    let cmder_path = format!(
        r"{}\vendor\bin\vscode_init.cmd",
        cmder_root.clone().unwrap_or_else(|| format!(r"{home_drive}\cmder"))
    );
    detected.insert(
        "Cmder".to_owned(),
        UnresolvedTerminalProfile {
            path: Some(SingleOrMany::One(ProfilePath::Plain(format!(r"{system32}\cmd.exe")))),
            args: Some(SingleOrMany::Many(vec!["/K".to_owned(), cmder_path.clone()])),
            // The path is safe if it was derived from CMDER_ROOT
            requires_path: Some(if cmder_root.is_some() {
                ProfilePath::Plain(cmder_path)
            } else {
                ProfilePath::unsafe_path(cmder_path)
            }),
            is_auto_detected: Some(true),
            ..UnresolvedTerminalProfile::default()
        },
    );
}

/// Determine the correct System32 path. We want to point to Sysnative when the
/// 32-bit version is running on a 64-bit machine, because PowerShell's PSReadline
/// module doesn't work if this is not the case (microsoft/vscode#27915).
fn system32_path() -> String {
    let is_32_process_on_64_windows = std::env::var_os("PROCESSOR_ARCHITEW6432").is_some();
    let windir = std::env::var("windir").unwrap_or_default();
    let system_dir = if is_32_process_on_64_windows {
        "Sysnative"
    } else {
        "System32"
    };
    format!(r"{windir}\{system_dir}")
}

/// Port of the `/etc/shells` half of `detectAvailableUnixProfiles`.
fn add_unix_detected_profiles(
    detected: &mut BTreeMap<String, UnresolvedTerminalProfile>,
    fs: &dyn FsProvider,
) {
    let Some(contents) = fs.read_file(Path::new(UNIX_SHELLS_PATH)) else {
        return;
    };
    let contents = String::from_utf8_lossy(&contents).into_owned();

    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for profile in contents
        .split('\n')
        .map(|line| line.split('#').next().unwrap_or(line))
        .filter(|line| !line.trim().is_empty())
    {
        let mut profile_name = node_basename(profile);
        let count = counts.get(&profile_name).copied().unwrap_or(0) + 1;
        if count > 1 {
            profile_name = format!("{profile_name} ({count})");
        }
        counts.insert(profile_name.clone(), count);
        detected.insert(
            profile_name,
            UnresolvedTerminalProfile {
                path: Some(SingleOrMany::One(ProfilePath::Plain(profile.to_owned()))),
                is_auto_detected: Some(true),
                ..UnresolvedTerminalProfile::default()
            },
        );
    }
}

/// Port of `initializeWindowsProfiles`.
fn initialize_windows_profiles(test_pwsh_source_paths: Option<Vec<String>>) {
    let mut sources = PROFILE_SOURCES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if sources.is_some() && test_pwsh_source_paths.is_none() {
        return;
    }

    let pwsh_paths = test_pwsh_source_paths.unwrap_or_else(|| {
        enumerate_powershell_installations()
            .into_iter()
            .map(|pwsh| pwsh.exe_path.to_string_lossy().into_owned())
            .collect()
    });

    *sources = Some(vec![
        (ProfileSource::GitBash, git_bash_paths()),
        (ProfileSource::Pwsh, pwsh_paths),
    ]);
}

fn profile_source(source: ProfileSource) -> Option<PotentialTerminalProfile> {
    let sources = PROFILE_SOURCES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let paths = sources
        .as_ref()?
        .iter()
        .find(|(candidate, _)| *candidate == source)?
        .1
        .clone();
    Some(match source {
        ProfileSource::GitBash => PotentialTerminalProfile {
            paths,
            args: Some(vec!["--login".to_owned(), "-i".to_owned()]),
            icon: None,
        },
        ProfileSource::Pwsh => PotentialTerminalProfile {
            paths,
            args: None,
            icon: Some(ThemeIcon::new("terminal-powershell")),
        },
    })
}

/// Port of `getGitBashPaths`.
fn git_bash_paths() -> Vec<String> {
    let mut git_dirs: Vec<String> = Vec::new();
    let add_truthy = |dirs: &mut Vec<String>, value: Option<String>| {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            if !dirs.contains(&value) {
                dirs.push(value);
            }
        }
    };

    // Look for git.exe on the PATH and use that if found. git.exe is located at
    // `<installdir>/cmd/git.exe`. This is not an unsafe location because the git
    // executable is located on the PATH, which is only controlled by the
    // user/admin.
    if let Some(git_exe) = find_executable("git.exe", None, None, None, &file_exists_default) {
        if let Some(git_exe_dir) = git_exe.parent() {
            let install_dir = git_exe_dir.join("..").join("..");
            if let Ok(resolved) = std::fs::canonicalize(&install_dir) {
                add_truthy(&mut git_dirs, Some(resolved.to_string_lossy().into_owned()));
            }
        }
    }

    // Add common git install locations
    for name in ["ProgramW6432", "ProgramFiles", "ProgramFiles(X86)"] {
        add_truthy(&mut git_dirs, std::env::var(name).ok());
    }
    add_truthy(
        &mut git_dirs,
        std::env::var("LocalAppData").ok().map(|dir| format!(r"{dir}\Program")),
    );

    let mut git_bash_paths = Vec::new();
    for git_dir in &git_dirs {
        git_bash_paths.push(format!(r"{git_dir}\Git\bin\bash.exe"));
        git_bash_paths.push(format!(r"{git_dir}\Git\usr\bin\bash.exe"));
        // using Git for Windows SDK
        git_bash_paths.push(format!(r"{git_dir}\usr\bin\bash.exe"));
    }

    // Add special installs that don't follow the standard directory structure
    if let Ok(user_profile) = std::env::var("UserProfile") {
        git_bash_paths.push(format!(r"{user_profile}\scoop\apps\git\current\bin\bash.exe"));
        git_bash_paths.push(format!(
            r"{user_profile}\scoop\apps\git-with-openssh\current\bin\bash.exe"
        ));
    }

    git_bash_paths
}

/// Port of `applyConfigProfilesToMap`.
fn apply_config_profiles_to_map(
    config_profiles: &BTreeMap<String, Option<UnresolvedTerminalProfile>>,
    profiles_map: &mut BTreeMap<String, UnresolvedTerminalProfile>,
) {
    for (profile_name, value) in config_profiles {
        match value {
            Some(value) if !value.is_deletion() => {
                let mut value = value.clone();
                value.icon = value
                    .icon
                    .or_else(|| profiles_map.get(profile_name).and_then(|old| old.icon.clone()));
                profiles_map.insert(profile_name.clone(), value);
            }
            _ => {
                profiles_map.remove(profile_name);
            }
        }
    }
}

/// Port of `getValidatedProfile`.
fn get_validated_profile(
    profile_name: &str,
    profile: &UnresolvedTerminalProfile,
    options: &DetectOptions,
    fs: &dyn FsProvider,
) -> Option<TerminalProfile> {
    let paths: Vec<ProfilePath>;
    let args: Option<SingleOrMany<String>>;
    let icon: Option<ThemeIcon>;

    // use calculated values if path is not specified
    if let Some(source) = profile.source {
        let source = profile_source(source)?;
        paths = source
            .paths
            .iter()
            .map(|path| ProfilePath::Plain(path.clone()))
            .collect();
        // if there are configured args, override the default ones
        args = profile
            .args
            .clone()
            .or_else(|| source.args.clone().map(SingleOrMany::Many));
        icon = profile.icon.clone().or(source.icon);
    } else {
        paths = profile.path.clone().map(SingleOrMany::into_vec).unwrap_or_default();
        args = profile.args.clone();
        icon = profile.icon.clone();
    }

    let mut requires_unsafe_path = None;
    if let Some(requires_path) = &profile.requires_path {
        if requires_path.is_unsafe() {
            requires_unsafe_path = Some(requires_path.path().to_owned());
        }
        if !fs.exists_file(Path::new(requires_path.path())) {
            return None;
        }
    }

    let mut candidates = paths;
    let mut validated = validate_profile_paths(
        profile_name,
        options.default_profile.as_deref(),
        &mut candidates,
        fs,
        &options.shell_env,
        args.as_ref(),
        profile.env.as_ref(),
        profile.override_name,
        profile.is_auto_detected,
        requires_unsafe_path.as_deref(),
    )?;

    validated.is_auto_detected = profile.is_auto_detected;
    validated.icon = icon;
    validated.color = profile.color.clone();
    Some(validated)
}

/// Port of `validateProfilePaths`. Stock recurses through the candidate paths;
/// each fallback drops a different subset of the profile's fields, so the
/// recursion is kept rather than flattened into a loop.
#[allow(clippy::too_many_arguments)]
fn validate_profile_paths(
    profile_name: &str,
    default_profile_name: Option<&str>,
    potential_paths: &mut Vec<ProfilePath>,
    fs: &dyn FsProvider,
    shell_env: &ProcessEnvironment,
    args: Option<&SingleOrMany<String>>,
    env: Option<&crate::types::TerminalEnvironment>,
    override_name: Option<bool>,
    is_auto_detected: Option<bool>,
    requires_unsafe_path: Option<&str>,
) -> Option<TerminalProfile> {
    if potential_paths.is_empty() {
        return None;
    }
    let path = potential_paths.remove(0);
    if path.path().is_empty() {
        // Stock drops `env`, `overrideName` and `isAutoDetected` on this arm.
        return validate_profile_paths(
            profile_name,
            default_profile_name,
            potential_paths,
            fs,
            shell_env,
            args,
            None,
            None,
            None,
            None,
        );
    }

    let actual_path = path.path().to_owned();
    let mut profile = TerminalProfile::new(
        profile_name.to_owned(),
        actual_path.clone(),
        Some(profile_name) == default_profile_name,
    );
    profile.args = args.cloned();
    profile.env = env.cloned();
    profile.override_name = override_name;
    profile.is_auto_detected = is_auto_detected;
    // Stock sets this on every profile, not only the unsafe ones — the frontend
    // shows a warning for a truthy value and reads an absent one as false.
    profile.is_unsafe_path = Some(path.is_unsafe());
    profile.requires_unsafe_path = requires_unsafe_path.map(str::to_owned);

    // For non-absolute paths, check if it's available on $PATH
    if node_basename(&actual_path) == actual_path {
        let env_paths: Option<Vec<String>> = shell_env
            .get("PATH")
            .map(|path| path.split(PATH_DELIMITER).map(str::to_owned).collect());
        let exists = |path: &Path| fs.exists_file(path);
        let executable = find_executable(&actual_path, None, env_paths.as_deref(), None, &exists);
        let Some(executable) = executable else {
            // Stock keeps only `args` on this arm.
            return validate_profile_paths(
                profile_name,
                default_profile_name,
                potential_paths,
                fs,
                shell_env,
                args,
                None,
                None,
                None,
                None,
            );
        };
        profile.path = executable.to_string_lossy().into_owned();
        profile.is_from_path = Some(true);
        return Some(profile);
    }

    if fs.exists_file(Path::new(&actual_path)) {
        return Some(profile);
    }

    validate_profile_paths(
        profile_name,
        default_profile_name,
        potential_paths,
        fs,
        shell_env,
        args,
        env,
        override_name,
        is_auto_detected,
        requires_unsafe_path,
    )
}

/// Port of `getWslProfiles`.
async fn wsl_profiles(
    system32: &str,
    default_profile_name: Option<&str>,
) -> Result<Vec<TerminalProfile>, String> {
    let wsl_path = format!(r"{system32}\wsl.exe");
    let mut command = tokio::process::Command::new(&wsl_path);
    // wsl.exe output is encoded in utf16le by default; force it in case the user
    // changed it (microsoft/vscode#276253).
    command.args(["-l", "-q"]).env("WSL_UTF8", "0");
    let output = tokio::time::timeout(
        WSL_LIST_TIMEOUT,
        tscode_proc::hide_console(&mut command).output(),
    )
    .await
    .map_err(|_| "wsl.exe -l -q timed out".to_owned())?
    .map_err(|error| format!("Problem occurred when getting wsl distros: {error}"))?;

    if !output.status.success() {
        return Err("Problem occurred when getting wsl distros".to_owned());
    }

    let distro_output = decode_utf16le(&output.stdout);
    Ok(distro_output
        .lines()
        .map(str::trim)
        .filter(|distro_name| !distro_name.is_empty())
        // docker-desktop and docker-desktop-data are treated as implementation
        // details of Docker Desktop for Windows and therefore not exposed.
        .filter(|distro_name| !distro_name.starts_with("docker-desktop"))
        .map(|distro_name| {
            let profile_name = format!("{distro_name} (WSL)");
            let mut profile = TerminalProfile::new(
                profile_name.clone(),
                wsl_path.clone(),
                Some(profile_name.as_str()) == default_profile_name,
            );
            profile.args = Some(SingleOrMany::Many(vec![
                "-d".to_owned(),
                distro_name.to_owned(),
            ]));
            profile.icon = Some(wsl_icon(distro_name));
            profile.is_auto_detected = Some(false);
            profile
        })
        .collect())
}

/// Port of `getWslIcon`.
fn wsl_icon(distro_name: &str) -> ThemeIcon {
    if distro_name.contains("Ubuntu") {
        ThemeIcon::new("terminal-ubuntu")
    } else if distro_name.contains("Debian") {
        ThemeIcon::new("terminal-debian")
    } else {
        ThemeIcon::new("terminal-linux")
    }
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Port of `createFsProvider` in
    /// `workbench/contrib/terminal/test/node/terminalProfiles.test.ts`.
    struct FixtureFs {
        expected_paths: Vec<String>,
        etc_shells: String,
    }

    impl FsProvider for FixtureFs {
        fn exists_file(&self, path: &Path) -> bool {
            self.expected_paths
                .iter()
                .any(|expected| Path::new(expected) == path)
        }

        fn read_file(&self, path: &Path) -> Option<Vec<u8>> {
            assert_eq!(path, Path::new(UNIX_SHELLS_PATH), "Unexpected path");
            Some(self.etc_shells.clone().into_bytes())
        }
    }

    fn fs(expected_paths: &[&str], etc_shells: &str) -> FixtureFs {
        FixtureFs {
            expected_paths: expected_paths.iter().map(|path| (*path).to_owned()).collect(),
            etc_shells: etc_shells.to_owned(),
        }
    }

    fn options(
        profiles: &[(&str, UnresolvedTerminalProfile)],
        include_detected_profiles: bool,
        test_pwsh_source_paths: Option<Vec<String>>,
    ) -> DetectOptions {
        DetectOptions {
            profiles: profiles
                .iter()
                .map(|(name, profile)| ((*name).to_owned(), Some(profile.clone())))
                .collect(),
            default_profile: None,
            include_detected_profiles,
            // Inert here: `detect_blocking` never reads it, and stock defaults it on.
            use_wsl_profiles: true,
            shell_env: ProcessEnvironment::new(),
            test_pwsh_source_paths,
        }
    }

    /// `PROFILE_SOURCES` is process-wide, exactly as stock's module-level
    /// `profileSources` is, so the tests that pin it run one at a time.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock_profile_sources() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn seed_profile_sources(git_bash: &[&str], pwsh: &[&str]) {
        *PROFILE_SOURCES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(vec![
            (
                ProfileSource::GitBash,
                git_bash.iter().map(|path| (*path).to_owned()).collect(),
            ),
            (
                ProfileSource::Pwsh,
                pwsh.iter().map(|path| (*path).to_owned()).collect(),
            ),
        ]);
    }

    fn from_source(source: ProfileSource) -> UnresolvedTerminalProfile {
        UnresolvedTerminalProfile {
            source: Some(source),
            ..UnresolvedTerminalProfile::default()
        }
    }

    fn from_path(path: &str) -> UnresolvedTerminalProfile {
        UnresolvedTerminalProfile {
            path: Some(SingleOrMany::One(ProfilePath::Plain(path.to_owned()))),
            ..UnresolvedTerminalProfile::default()
        }
    }

    /// Stock's `profilesEqual`: order is ignored and an explicit `undefined` and
    /// an unset property are the same.
    fn profiles_equal(actual: &[TerminalProfile], expected: &[TerminalProfile]) {
        assert_eq!(
            actual.len(),
            expected.len(),
            "Actual: {:?}\nExpected: {:?}",
            actual.iter().map(|p| &p.profile_name).collect::<Vec<_>>(),
            expected.iter().map(|p| &p.profile_name).collect::<Vec<_>>()
        );
        for want in expected {
            let got = actual
                .iter()
                .find(|profile| profile.profile_name == want.profile_name)
                .unwrap_or_else(|| panic!("Expected profile {} not found", want.profile_name));
            assert_eq!(got.path, want.path);
            assert_eq!(got.args, want.args);
            assert_eq!(got.is_auto_detected, want.is_auto_detected);
            assert_eq!(got.override_name, want.override_name);
        }
    }

    fn expected(name: &str, path: &str, args: Option<Vec<String>>) -> TerminalProfile {
        let mut profile = TerminalProfile::new(name.to_owned(), path.to_owned(), true);
        profile.args = args.map(SingleOrMany::Many);
        profile
    }

    /// The detection both pwsh candidate-ordering tests run: one `PowerShell` profile from the
    /// `Pwsh` source over the candidate list `test_pwsh_source_paths` pins, with every candidate
    /// on disk. The order of `paths` is the whole subject, so it is all the tests differ in.
    fn detect_pwsh(paths: &[String]) -> Vec<TerminalProfile> {
        let known: Vec<&str> = paths.iter().map(String::as_str).collect();
        detect_blocking(
            &options(
                &[("PowerShell", from_source(ProfileSource::Pwsh))],
                false,
                Some(paths.to_vec()),
            ),
            &fs(&known, ""),
        )
    }

    /// The detection both `/etc/shells` tests run: three bare shell names looked up on a `PATH`
    /// of `/bin`, with `/etc/shells` naming the first and third. `on_disk` is what the fixture
    /// filesystem actually has, which is all the tests differ in.
    fn detect_etc_shells(on_disk: &[&str]) -> Vec<TerminalProfile> {
        let mut opts = options(
            &[
                ("fakeshell1", from_path("fakeshell1")),
                ("fakeshell2", from_path("fakeshell2")),
                ("fakeshell3", from_path("fakeshell3")),
            ],
            true,
            None,
        );
        opts.shell_env.insert("PATH".to_owned(), "/bin".to_owned());

        detect_blocking(&opts, &fs(on_disk, "/bin/fakeshell1\n/bin/fakeshell3"))
    }

    /// Port of `should detect Git Bash and provide login args`.
    #[test]
    fn windows_git_bash_gets_login_args() {
        if !cfg!(windows) {
            return;
        }
        let _guard = lock_profile_sources();
        let path = r"C:\Program Files\Git\bin\bash.exe";
        // Stock has no `testGitBashSourcePaths`, so the Git Bash candidates are
        // pinned by seeding the cache the way `testPwshSourcePaths` seeds pwsh's.
        seed_profile_sources(&[path], &[]);

        let profiles = detect_blocking(
            &options(&[("Git Bash", from_source(ProfileSource::GitBash))], false, None),
            &fs(&[path], ""),
        );
        profiles_equal(
            &profiles,
            &[expected(
                "Git Bash",
                path,
                Some(vec!["--login".to_owned(), "-i".to_owned()]),
            )],
        );
    }

    /// Port of `should allow source to have args`.
    #[test]
    fn windows_a_source_profile_can_override_its_args() {
        if !cfg!(windows) {
            return;
        }
        let _guard = lock_profile_sources();
        let path = r"C:\Program Files\PowerShell\7\pwsh.exe";
        let mut profile = from_source(ProfileSource::Pwsh);
        profile.args = Some(SingleOrMany::Many(vec!["-NoProfile".to_owned()]));
        profile.override_name = Some(true);

        let profiles = detect_blocking(
            &options(&[("PowerShell", profile)], false, Some(vec![path.to_owned()])),
            &fs(&[path], ""),
        );

        let mut want = expected("PowerShell", path, Some(vec!["-NoProfile".to_owned()]));
        want.override_name = Some(true);
        profiles_equal(&profiles, &[want]);
    }

    /// Port of `should prefer pwsh 7 to Windows PowerShell` and
    /// `should prefer pwsh 7 to pwsh 6`: the first existing candidate wins, and
    /// `powershell.ts` yields them newest first.
    #[test]
    fn windows_the_first_existing_pwsh_candidate_wins() {
        if !cfg!(windows) {
            return;
        }
        let _guard = lock_profile_sources();
        let paths = vec![
            r"C:\Program Files\PowerShell\7\pwsh.exe".to_owned(),
            r"C:\Program Files\PowerShell\6\pwsh.exe".to_owned(),
            r"C:\Sysnative\WindowsPowerShell\v1.0\powershell.exe".to_owned(),
            r"C:\System32\WindowsPowerShell\v1.0\powershell.exe".to_owned(),
        ];

        let profiles = detect_pwsh(&paths);
        profiles_equal(
            &profiles,
            &[expected("PowerShell", &paths[0], None)],
        );
    }

    /// Port of `should fallback to Windows PowerShell`.
    #[test]
    fn windows_powershell_is_the_fallback() {
        if !cfg!(windows) {
            return;
        }
        let _guard = lock_profile_sources();
        let paths = vec![
            r"C:\Windows\Sysnative\WindowsPowerShell\v1.0\powershell.exe".to_owned(),
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".to_owned(),
        ];

        let profiles = detect_pwsh(&paths);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].profile_name, "PowerShell");
    }

    /// Port of `should detect shells via absolute paths`.
    #[test]
    fn unix_absolute_paths_are_detected() {
        if cfg!(windows) {
            return;
        }
        let profiles = detect_blocking(
            &options(
                &[
                    ("fakeshell1", from_path("/bin/fakeshell1")),
                    ("fakeshell2", from_path("/bin/fakeshell2")),
                    ("fakeshell3", from_path("/bin/fakeshell3")),
                ],
                false,
                None,
            ),
            &fs(&["/bin/fakeshell1", "/bin/fakeshell3"], ""),
        );
        profiles_equal(
            &profiles,
            &[
                expected("fakeshell1", "/bin/fakeshell1", None),
                expected("fakeshell3", "/bin/fakeshell3", None),
            ],
        );
    }

    /// Port of `should auto detect shells via /etc/shells`.
    #[test]
    fn unix_etc_shells_entries_are_looked_up_on_the_path() {
        if cfg!(windows) {
            return;
        }
        let profiles = detect_etc_shells(&["/etc/shells", "/bin/fakeshell1", "/bin/fakeshell3"]);
        profiles_equal(
            &profiles,
            &[
                expected("fakeshell1", "/bin/fakeshell1", None),
                expected("fakeshell3", "/bin/fakeshell3", None),
            ],
        );
        assert!(profiles.iter().all(|profile| profile.is_from_path == Some(true)));
    }

    /// Port of `should validate auto detected shells from /etc/shells exist`.
    #[test]
    fn unix_an_etc_shells_entry_that_is_not_on_disk_is_dropped() {
        if cfg!(windows) {
            return;
        }
        let profiles = detect_etc_shells(&["/etc/shells", "/bin/fakeshell1"]);
        profiles_equal(&profiles, &[expected("fakeshell1", "/bin/fakeshell1", None)]);
    }

    #[test]
    fn a_null_configured_profile_deletes_a_detected_one() {
        let mut detected = BTreeMap::new();
        detected.insert("Git Bash".to_owned(), from_source(ProfileSource::GitBash));

        let mut config = BTreeMap::new();
        config.insert("Git Bash".to_owned(), None);
        apply_config_profiles_to_map(&config, &mut detected);

        assert!(detected.is_empty());
    }

    #[test]
    fn a_configured_profile_inherits_the_detected_icon() {
        let mut detected = BTreeMap::new();
        detected.insert(
            "Command Prompt".to_owned(),
            UnresolvedTerminalProfile {
                path: Some(SingleOrMany::One(ProfilePath::Plain("cmd.exe".to_owned()))),
                icon: Some(ThemeIcon::new("terminal-cmd")),
                ..UnresolvedTerminalProfile::default()
            },
        );

        let mut config = BTreeMap::new();
        config.insert("Command Prompt".to_owned(), Some(from_path("other.exe")));
        apply_config_profiles_to_map(&config, &mut detected);

        assert_eq!(
            detected["Command Prompt"].icon,
            Some(ThemeIcon::new("terminal-cmd"))
        );
    }

    #[test]
    fn utf16le_output_decodes_to_distro_names() {
        let bytes: Vec<u8> = "Ubuntu\r\nDebian\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(decode_utf16le(&bytes), "Ubuntu\r\nDebian\r\n");
    }

    #[test]
    fn wsl_icons_follow_the_distro_name() {
        assert_eq!(wsl_icon("Ubuntu-22.04"), ThemeIcon::new("terminal-ubuntu"));
        assert_eq!(wsl_icon("Debian"), ThemeIcon::new("terminal-debian"));
        assert_eq!(wsl_icon("Alpine"), ThemeIcon::new("terminal-linux"));
    }
}
