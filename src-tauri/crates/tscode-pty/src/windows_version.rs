//! Port of `vs/base/node/windowsVersion.ts` — the Windows build number.
//!
//! Three decisions read it: whether conpty is available (>= 18309), whether WSL
//! profile discovery may use `wsl.exe -d` (>= 19041), and whether `wslpath`
//! exists (>= 17063).
//!
//! Stock reads it from `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` via
//! `@vscode/windows-registry` rather than from `os.release()`, because
//! `GetVersionEx` returns compatibility-shimmed values to a process without a
//! version manifest (microsoft/vscode#197444). This does the same registry read
//! and falls back the same way.

use std::sync::OnceLock;

/// Stock's module-level `versionInfo` cache. The build number cannot change
/// while the process runs, so there is nothing to invalidate.
static BUILD_NUMBER: OnceLock<u32> = OnceLock::new();

/// Port of `getWindowsBuildNumberSync`. Zero on every other platform, as stock
/// returns for `!isWindows`.
pub fn windows_build_number() -> u32 {
    *BUILD_NUMBER.get_or_init(read_build_number)
}

#[cfg(windows)]
fn read_build_number() -> u32 {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let from_registry = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .ok()
        .and_then(|key| key.get_value::<String, _>("CurrentBuild").ok())
        .and_then(|build| build.parse::<u32>().ok());

    from_registry.unwrap_or_else(build_number_from_kernel_version)
}

#[cfg(not(windows))]
fn read_build_number() -> u32 {
    0
}

/// Stock's `getWindowsBuildNumberFromOsRelease` fallback: the third component of
/// `os.release()`. `sysinfo` reports that same value as the kernel version on
/// Windows.
#[cfg(windows)]
fn build_number_from_kernel_version() -> u32 {
    sysinfo::System::kernel_version()
        .and_then(|version| version.rsplit('.').next().and_then(|part| part.parse().ok()))
        .unwrap_or(0)
}
