//! Port of `vs/base/node/powershell.ts` — the well-known PowerShell
//! installations, in the order stock searches them.
//!
//! Order is the whole point of this file: `getSystemShell` on Windows takes the
//! *first* hit, and `terminalProfiles.ts` uses the full list as the `PowerShell`
//! profile source's candidate paths. Windows PowerShell is always last, so it is
//! the fallback and never the preference.
//!
//! Blocking: stats the filesystem. Callers run it inside `spawn_blocking`.

use std::path::{Path, PathBuf};

/// This is required, since `parseInt("7-preview")` would return 7.
fn is_int(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

const PWSH_MSIX_PREFIX: &str = "Microsoft.PowerShell_";
const PWSH_PREVIEW_MSIX_PREFIX: &str = "Microsoft.PowerShellPreview_";

/// Stock's `Arch`, which distinguishes the *process* bitness from the *OS*
/// bitness so a 32-bit build on 64-bit Windows still finds 64-bit PowerShell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arch {
    X64,
    X86,
    Arm,
}

fn process_arch() -> Arch {
    match std::env::consts::ARCH {
        "x86" => Arch::X86,
        "arm" | "aarch64" => Arch::Arm,
        _ => Arch::X64,
    }
}

/// The comment block in stock enumerating what `PROCESSOR_ARCHITECTURE` and
/// `PROCESSOR_ARCHITEW6432` hold per architecture is the specification for this.
fn os_arch() -> Arch {
    if let Ok(wow64) = std::env::var("PROCESSOR_ARCHITEW6432") {
        return if wow64 == "ARM64" { Arch::Arm } else { Arch::X64 };
    }
    match std::env::var("PROCESSOR_ARCHITECTURE").as_deref() {
        Ok("ARM64") => Arch::Arm,
        Ok("X86") => Arch::X86,
        _ => Arch::X64,
    }
}

/// Stock `IPowerShellExeDetails`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PowerShellExeDetails {
    pub display_name: String,
    pub exe_path: PathBuf,
}

/// Stock `IPossiblePowerShellExe`: a candidate plus whether its existence is
/// already known (the two installations stock builds by path rather than by
/// directory scan are constructed `knownToExist`).
struct PossiblePowerShellExe {
    details: PowerShellExeDetails,
    known_to_exist: bool,
}

impl PossiblePowerShellExe {
    fn new(exe_path: PathBuf, display_name: &str, known_to_exist: bool) -> Self {
        Self {
            details: PowerShellExeDetails {
                display_name: display_name.to_owned(),
                exe_path,
            },
            known_to_exist,
        }
    }

    fn exists(&self) -> bool {
        self.known_to_exist || self.details.exe_path.is_file()
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

/// Port of `getProgramFilesPath`.
fn program_files_path(use_alternate_bitness: bool) -> Option<PathBuf> {
    if !use_alternate_bitness {
        // Just use the native system bitness
        return env_path("ProgramFiles");
    }

    // We might be a 64-bit process looking for 32-bit program files
    if process_arch() == Arch::X64 {
        return env_path("ProgramFiles(x86)");
    }

    // We might be a 32-bit process looking for 64-bit program files
    if os_arch() == Arch::X64 {
        return env_path("ProgramW6432");
    }

    // We're a 32-bit process on 32-bit Windows, there is no other Program Files dir
    None
}

/// Port of `findPSCoreWindowsInstallation`: the highest-numbered version
/// directory under `<Program Files>\PowerShell` that actually contains
/// `pwsh.exe`.
fn find_ps_core_windows_installation(
    use_alternate_bitness: bool,
    find_preview: bool,
) -> Option<PossiblePowerShellExe> {
    let program_files_path = program_files_path(use_alternate_bitness)?;
    let install_base_dir = program_files_path.join("PowerShell");
    if !install_base_dir.is_dir() {
        return None;
    }

    let mut highest_seen_version: i64 = -1;
    let mut pwsh_exe_path: Option<PathBuf> = None;
    for entry in std::fs::read_dir(&install_base_dir).ok()?.flatten() {
        let item = entry.file_name().to_string_lossy().into_owned();

        let current_version = if find_preview {
            // We are looking for something like "7-preview": preview dirs all
            // have dashes, the part before must be an integer and the part
            // after must be exactly "preview".
            let Some((int_part, suffix)) = item.split_once('-') else {
                continue;
            };
            if !is_int(int_part) || suffix != "preview" {
                continue;
            }
            let Ok(version) = int_part.parse::<i64>() else {
                continue;
            };
            version
        } else {
            // Search for a directory like "6" or "7"
            if !is_int(&item) {
                continue;
            }
            let Ok(version) = item.parse::<i64>() else {
                continue;
            };
            version
        };

        // Ensure we haven't already seen a higher version
        if current_version <= highest_seen_version {
            continue;
        }

        let exe_path = install_base_dir.join(&item).join("pwsh.exe");
        if !exe_path.is_file() {
            continue;
        }

        pwsh_exe_path = Some(exe_path);
        highest_seen_version = current_version;
    }

    let pwsh_exe_path = pwsh_exe_path?;
    let bitness = if program_files_path.to_string_lossy().contains("x86") {
        " (x86)"
    } else {
        ""
    };
    let preview = if find_preview { " Preview" } else { "" };

    Some(PossiblePowerShellExe::new(
        pwsh_exe_path,
        &format!("PowerShell{preview}{bitness}"),
        true,
    ))
}

/// Port of `findPSCoreMsix`.
fn find_ps_core_msix(find_preview: bool) -> Option<PossiblePowerShellExe> {
    let msix_app_dir = env_path("LOCALAPPDATA")?.join("Microsoft").join("WindowsApps");
    if !msix_app_dir.is_dir() {
        return None;
    }

    let (prefix, name) = if find_preview {
        (PWSH_PREVIEW_MSIX_PREFIX, "PowerShell Preview (Store)")
    } else {
        (PWSH_MSIX_PREFIX, "PowerShell (Store)")
    };

    // We should find only one such application, so return on the first one
    for entry in std::fs::read_dir(&msix_app_dir).ok()?.flatten() {
        let subdir = entry.file_name().to_string_lossy().into_owned();
        if subdir.starts_with(prefix) {
            return Some(PossiblePowerShellExe::new(
                msix_app_dir.join(subdir).join("pwsh.exe"),
                name,
                false,
            ));
        }
    }

    None
}

/// Stock resolves `~` with `os.homedir()`; there is no hardcoded path anywhere
/// in this file.
fn home_dir() -> Option<PathBuf> {
    env_path("USERPROFILE").or_else(|| env_path("HOME"))
}

/// Port of `findPSCoreDotnetGlobalTool`.
fn find_ps_core_dotnet_global_tool() -> Option<PossiblePowerShellExe> {
    let path = home_dir()?.join(".dotnet").join("tools").join("pwsh.exe");
    Some(PossiblePowerShellExe::new(
        path,
        ".NET Core PowerShell Global Tool",
        false,
    ))
}

/// Port of `findPSCoreScoopInstallation`.
fn find_ps_core_scoop_installation() -> Option<PossiblePowerShellExe> {
    let path = home_dir()?
        .join("scoop")
        .join("apps")
        .join("pwsh")
        .join("current")
        .join("pwsh.exe");
    Some(PossiblePowerShellExe::new(path, "PowerShell (Scoop)", false))
}

/// Port of `findWinPS`.
fn find_win_ps() -> Option<PossiblePowerShellExe> {
    let system_dir = if process_arch() == Arch::X86 && os_arch() != Arch::X86 {
        "SysNative"
    } else {
        "System32"
    };
    let path = env_path("windir")?
        .join(system_dir)
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");

    Some(PossiblePowerShellExe::new(path, "Windows PowerShell", true))
}

/// Port of `enumerateDefaultPowerShellInstallations`. The order is the search
/// order and is load-bearing.
fn enumerate_default_powershell_installations() -> Vec<PossiblePowerShellExe> {
    [
        // Find PSCore stable first
        find_ps_core_windows_installation(false, false),
        // Windows may have a 32-bit pwsh.exe
        find_ps_core_windows_installation(true, false),
        // Also look for the MSIX/UWP installation
        find_ps_core_msix(false),
        // Look for the .NET global tool
        find_ps_core_dotnet_global_tool(),
        // Look for PSCore preview
        find_ps_core_windows_installation(false, true),
        // Find a preview MSIX
        find_ps_core_msix(true),
        // Look for pwsh-preview with the opposite bitness
        find_ps_core_windows_installation(true, true),
        find_ps_core_scoop_installation(),
        // Finally, get Windows PowerShell
        find_win_ps(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Port of `enumeratePowerShellInstallations`: the default list, filtered to
/// what is on disk.
pub fn enumerate_powershell_installations() -> Vec<PowerShellExeDetails> {
    enumerate_default_powershell_installations()
        .into_iter()
        .filter(PossiblePowerShellExe::exists)
        .map(|candidate| candidate.details)
        .collect()
}

/// Port of `getFirstAvailablePowerShellInstallation`.
pub fn first_available_powershell_installation() -> Option<PowerShellExeDetails> {
    enumerate_default_powershell_installations()
        .into_iter()
        .find(PossiblePowerShellExe::exists)
        .map(|candidate| candidate.details)
}

/// Whether a path is the `powershell.exe`/`pwsh.exe` name stock's shell-name
/// checks look for, used by [`crate::shell_env`] to pick the login arguments.
pub fn is_powershell_name(name: &str) -> bool {
    let name = Path::new(name)
        .file_stem()
        .map_or_else(String::new, |stem| stem.to_string_lossy().to_lowercase());
    matches!(
        name.as_str(),
        "pwsh" | "powershell" | "pwsh-preview" | "powershell-preview"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Port of `base/test/node/powershell.test.ts`, which only runs on Windows:
    /// every returned path must exist, and Windows PowerShell must be last.
    #[test]
    fn can_enumerate_powershells() {
        if !cfg!(windows) {
            return;
        }
        let pwshs = enumerate_powershell_installations();
        assert!(!pwshs.is_empty(), "expected at least one PowerShell");
        for pwsh in &pwshs {
            assert!(pwsh.exe_path.is_file(), "{} is not a file", pwsh.exe_path.display());
        }
        assert_eq!(pwshs.last().unwrap().display_name, "Windows PowerShell");
    }

    /// Port of `Can find first available PowerShell`.
    #[test]
    fn can_find_the_first_available_powershell() {
        if !cfg!(windows) {
            return;
        }
        let pwsh = first_available_powershell_installation().expect("no PowerShell found");
        assert!(!pwsh.display_name.is_empty());
        assert!(pwsh.exe_path.is_file());
    }

    #[test]
    fn a_preview_version_is_not_an_integer() {
        assert!(is_int("7"));
        assert!(!is_int("7-preview"));
        assert!(!is_int(""));
    }

    #[test]
    fn powershell_names_are_matched_with_and_without_an_extension() {
        assert!(is_powershell_name("pwsh"));
        assert!(is_powershell_name("PowerShell.exe"));
        assert!(is_powershell_name("pwsh-preview"));
        assert!(!is_powershell_name("bash"));
    }
}
