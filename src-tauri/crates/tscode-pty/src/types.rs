//! The terminal wire vocabulary, ported from
//! `vs/platform/terminal/common/terminal.ts`.
//!
//! Every name here is stock's, and every string value is stock's string value —
//! the vendored frontend compares against them directly, so a renamed variant is
//! a silent behaviour change rather than a compile error.

use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};

//#region Flow control

/// Stock `FlowControlConstants`.
///
/// The client acks every [`CHAR_COUNT_ACK_SIZE`] characters, which must stay
/// less than or equal to [`LOW_WATERMARK_CHARS`] or a paused terminal never
/// resumes.
pub mod flow_control {
    /// Unacknowledged characters at which the pty is paused so the client can
    /// catch up.
    pub const HIGH_WATERMARK_CHARS: usize = 100_000;
    /// Unacknowledged characters at which a paused pty resumes.
    pub const LOW_WATERMARK_CHARS: usize = 5_000;
    /// Characters the client accumulates before acking. Not read here — it is
    /// the frontend's half of the contract, kept beside the other two so the
    /// invariant between them is visible in one place.
    pub const CHAR_COUNT_ACK_SIZE: usize = 5_000;
}

//#endregion

//#region Shell launch

/// Stock `SingleOrMany<T>`: a field typed `T | T[]` on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SingleOrMany<T> {
    One(T),
    Many(Vec<T>),
}

impl<T: Clone> SingleOrMany<T> {
    pub fn into_vec(self) -> Vec<T> {
        match self {
            Self::One(value) => vec![value],
            Self::Many(values) => values,
        }
    }
}

/// Stock `IShellLaunchConfig.cwd`, typed `string | URI`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ConfigCwd {
    /// A `URI`, whose `path` is what stock reads (`slc.cwd instanceof URI ?
    /// slc.cwd.path : slc.cwd`).
    Uri { path: String },
    Path(String),
}

impl ConfigCwd {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Uri { path } | Self::Path(path) => path,
        }
    }
}

/// Stock `ITerminalEnvironment`: a `null` value means "remove this variable".
pub type TerminalEnvironment = HashMap<String, Option<String>>;

/// Stock `IShellLaunchConfig.initialText`, typed
/// `string | { text, trailingNewLine }`. Stock reads only its presence, to set
/// conpty's `inheritCursor`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum InitialText {
    Text(String),
    Styled { text: String },
}

/// The subset of stock `IShellLaunchConfig` a pty needs. The rest of the config
/// never leaves the frontend.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellLaunchConfig {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub executable: Option<String>,
    #[serde(default)]
    pub args: Option<SingleOrMany<String>>,
    #[serde(default)]
    pub cwd: Option<ConfigCwd>,
    #[serde(default)]
    pub env: Option<TerminalEnvironment>,
    #[serde(default)]
    pub initial_text: Option<InitialText>,
}

impl ShellLaunchConfig {
    pub fn args(&self) -> Vec<String> {
        self.args.clone().map(SingleOrMany::into_vec).unwrap_or_default()
    }
}

/// The subset of stock `ITerminalProcessOptions` that reaches the OS. Shell
/// integration is resolved in the frontend (`getShellIntegrationInjection` is
/// vendored), so only the nonce and the conpty backend choice arrive here.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProcessOptions {
    #[serde(default)]
    pub windows_use_conpty_dll: bool,
}

//#endregion

//#region Shell types

/// Stock `TerminalShellType` — the flattened union of `PosixShellType`,
/// `WindowsShellType` and `GeneralShellType`, which share one string space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalShellType {
    // PosixShellType
    Bash,
    Fish,
    Sh,
    Csh,
    Ksh,
    Zsh,
    // WindowsShellType
    #[serde(rename = "cmd")]
    CommandPrompt,
    #[serde(rename = "wsl")]
    Wsl,
    #[serde(rename = "gitbash")]
    GitBash,
    // GeneralShellType
    Claude,
    Codex,
    #[serde(rename = "commandcode")]
    CommandCode,
    Copilot,
    Gemini,
    #[serde(rename = "pwsh")]
    PowerShell,
    Python,
    Julia,
    #[serde(rename = "nu")]
    NuShell,
    Node,
    Xonsh,
}

//#endregion

//#region Process properties

/// Stock `ProcessPropertyType`, as `refreshProperty` / `updateProperty` name it
/// on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessPropertyType {
    Cwd,
    InitialCwd,
    FixedDimensions,
    Title,
    ShellType,
    HasChildProcesses,
    ResolvedShellLaunchConfig,
    OverrideDimensions,
    FailedShellIntegrationActivation,
    UsedShellIntegrationInjection,
    ShellIntegrationInjectionFailureReason,
}

/// Stock `IFixedTerminalDimensions`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedTerminalDimensions {
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

/// Stock `IProcessProperty` — the `{ type, value }` pair `onDidChangeProperty`
/// carries.
///
/// Only the properties `TerminalProcess` itself fires are variants. The
/// shell-integration ones (`usedShellIntegrationInjection`,
/// `failedShellIntegrationActivation`, `shellIntegrationInjectionFailureReason`)
/// are fired by the vendored frontend, which is where the injection is now
/// resolved; `resolvedShellLaunchConfig` and `overrideDimensions` are fired only
/// by `ptyService.ts` and the extension-host proxy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ProcessProperty {
    Cwd(String),
    InitialCwd(String),
    Title(String),
    ShellType(Option<TerminalShellType>),
    HasChildProcesses(bool),
}

//#endregion

//#region Launch results

/// Stock `IProcessReadyEvent`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessReadyEvent {
    pub pid: u32,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_pty: Option<ProcessReadyWindowsPty>,
}

/// Stock `IProcessReadyWindowsPty`. Winpty was removed upstream, so `backend` is
/// the constant `"conpty"`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessReadyWindowsPty {
    pub backend: &'static str,
    pub build_number: u32,
}

//#endregion

//#region Profiles

/// Stock `ThemeIcon`. Detected profiles only ever carry a codicon id.
///
/// A configured profile carries that id as a bare string — every default in
/// stock's own `terminal.integrated.profiles.windows` does — so the two shapes
/// both deserialize here, which is stock's `validateIcon` in the one place a
/// profile can arrive from settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThemeIcon {
    pub id: String,
}

impl<'de> Deserialize<'de> for ThemeIcon {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Id(String),
            Icon { id: String },
        }
        let (Wire::Id(id) | Wire::Icon { id }) = Wire::deserialize(deserializer)?;
        Ok(Self { id })
    }
}

impl ThemeIcon {
    pub fn new(id: &str) -> Self {
        Self { id: id.to_owned() }
    }
}

/// Stock `ITerminalProfile`, the result of profile detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub profile_name: String,
    pub path: String,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_unsafe_path: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_unsafe_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_auto_detected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_from_path: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<SingleOrMany<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<TerminalEnvironment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_name: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<ThemeIcon>,
}

impl TerminalProfile {
    /// The shape every construction site starts from: everything optional unset.
    pub fn new(profile_name: String, path: String, is_default: bool) -> Self {
        Self {
            profile_name,
            path,
            is_default,
            is_unsafe_path: None,
            requires_unsafe_path: None,
            is_auto_detected: None,
            is_from_path: None,
            args: None,
            env: None,
            override_name: None,
            color: None,
            icon: None,
        }
    }
}

/// Stock `ITerminalUnsafePath`, and the `string | ITerminalUnsafePath` union a
/// profile's `path` entries use.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum ProfilePath {
    #[serde(rename_all = "camelCase")]
    Unsafe { path: String, is_unsafe: bool },
    Plain(String),
}

impl ProfilePath {
    pub fn path(&self) -> &str {
        match self {
            Self::Unsafe { path, .. } | Self::Plain(path) => path,
        }
    }

    pub fn is_unsafe(&self) -> bool {
        matches!(self, Self::Unsafe { is_unsafe: true, .. })
    }

    /// The unsafe form, as the Windows detection table builds it.
    pub fn unsafe_path(path: impl Into<String>) -> Self {
        Self::Unsafe {
            path: path.into(),
            is_unsafe: true,
        }
    }
}

/// Stock `ProfileSource` — the two profiles whose paths are discovered rather
/// than configured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
pub enum ProfileSource {
    #[serde(rename = "Git Bash")]
    GitBash,
    #[serde(rename = "PowerShell")]
    Pwsh,
}

/// Stock `IUnresolvedTerminalProfile` = `ITerminalExecutable |
/// ITerminalProfileSource | null`.
///
/// The `null` arm is how a user deletes a detected profile in settings; it
/// arrives as an absent `path` *and* absent `source`, which
/// `apply_config_profiles_to_map` treats exactly as stock does.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedTerminalProfile {
    #[serde(default)]
    pub path: Option<SingleOrMany<ProfilePath>>,
    #[serde(default)]
    pub source: Option<ProfileSource>,
    #[serde(default)]
    pub args: Option<SingleOrMany<String>>,
    #[serde(default)]
    pub is_auto_detected: Option<bool>,
    #[serde(default)]
    pub override_name: Option<bool>,
    #[serde(default)]
    pub icon: Option<ThemeIcon>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub env: Option<TerminalEnvironment>,
    #[serde(default)]
    pub requires_path: Option<ProfilePath>,
}

impl UnresolvedTerminalProfile {
    /// Stock's `!hasKey(value, { path: true }) && !hasKey(value, { source: true })`.
    pub fn is_deletion(&self) -> bool {
        self.path.is_none() && self.source.is_none()
    }
}

//#endregion

//#region Platform

/// Stock `OperatingSystem` from `vs/base/common/platform.ts`, whose numeric
/// values cross the wire as `getDefaultSystemShell`'s `osOverride`.
///
/// Deserialize only: nothing sends one back, and a derived `Serialize` would
/// emit the variant name where the wire carries the number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(try_from = "u8")]
pub enum OperatingSystem {
    Windows = 1,
    Macintosh = 2,
    Linux = 3,
}

impl TryFrom<u8> for OperatingSystem {
    type Error = String;

    fn try_from(value: u8) -> std::result::Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Windows),
            2 => Ok(Self::Macintosh),
            3 => Ok(Self::Linux),
            other => Err(format!("unknown OperatingSystem: {other}")),
        }
    }
}

impl OperatingSystem {
    /// Stock `OS`: the platform this process is running on.
    pub fn host() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macintosh
        } else {
            Self::Linux
        }
    }
}

//#endregion

/// The process environment, in the shape every entry point here passes around.
pub type ProcessEnvironment = HashMap<String, String>;

/// Stock's `process.env`.
pub fn current_environment() -> ProcessEnvironment {
    std::env::vars().collect()
}

/// Port of `getCaseInsensitive` in `vs/base/common/objects.ts`, which
/// `findExecutable` uses to read `PATH` and `PATHEXT` on Windows, where the
/// casing of an environment variable is not fixed.
pub fn get_case_insensitive<'a>(env: &'a ProcessEnvironment, key: &str) -> Option<&'a String> {
    if let Some(value) = env.get(key) {
        return Some(value);
    }
    let lowered = key.to_lowercase();
    env.iter()
        .find(|(name, _)| name.to_lowercase() == lowered)
        .map(|(_, value)| value)
}

/// `path.delimiter`: what separates entries in `PATH`.
pub const PATH_DELIMITER: char = if cfg!(windows) { ';' } else { ':' };

/// Port of `path.dirname` from `vs/base/common/path.ts`, whose result for a bare
/// file name is `.` — `Path::parent` reports that as an empty component, and
/// `findExecutable` branches on the difference.
pub fn node_dirname(value: &str) -> String {
    match std::path::Path::new(value).parent() {
        Some(parent) if parent.as_os_str().is_empty() => ".".to_owned(),
        Some(parent) => parent.to_string_lossy().into_owned(),
        None => value.to_owned(),
    }
}

/// `path.basename`, as stock uses it on profile paths and process titles.
pub fn node_basename(value: &str) -> String {
    std::path::Path::new(value)
        .file_name()
        .map_or_else(|| value.to_owned(), |name| name.to_string_lossy().into_owned())
}

/// `path.parse(x).name`: the base name with its extension removed, which
/// `childProcessMonitor.ts` matches against its ignore list.
pub fn node_stem(value: &str) -> String {
    std::path::Path::new(value)
        .file_stem()
        .map_or_else(|| value.to_owned(), |name| name.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirname_matches_node() {
        assert_eq!(node_dirname("bash"), ".");
        assert_eq!(node_dirname("./bash"), ".");
        assert_eq!(node_dirname("bin/bash"), "bin");
    }

    #[test]
    fn a_profile_icon_reads_as_a_string_or_an_object() {
        let profile: UnresolvedTerminalProfile =
            serde_json::from_value(serde_json::json!({ "path": "cmd.exe", "icon": "terminal-cmd" }))
                .expect("a bare codicon id is what stock's own profile defaults carry");
        assert_eq!(profile.icon, Some(ThemeIcon::new("terminal-cmd")));

        let profile: UnresolvedTerminalProfile =
            serde_json::from_value(serde_json::json!({ "path": "cmd.exe", "icon": { "id": "terminal-cmd" } }))
                .unwrap();
        assert_eq!(profile.icon, Some(ThemeIcon::new("terminal-cmd")));
    }

    #[test]
    fn stem_drops_the_extension() {
        assert_eq!(node_stem("powershell.exe"), "powershell");
        assert_eq!(node_stem("/usr/bin/zsh"), "zsh");
    }

    #[test]
    fn path_is_read_whatever_its_casing() {
        let env: ProcessEnvironment = [("Path".to_owned(), "/usr/bin".to_owned())].into();
        assert_eq!(get_case_insensitive(&env, "PATH").unwrap(), "/usr/bin");
    }

    #[test]
    fn shell_types_serialize_to_their_stock_string_values() {
        let json = serde_json::to_string(&TerminalShellType::CommandPrompt).unwrap();
        assert_eq!(json, "\"cmd\"");
        assert_eq!(
            serde_json::to_string(&TerminalShellType::PowerShell).unwrap(),
            "\"pwsh\""
        );
        assert_eq!(serde_json::to_string(&TerminalShellType::Bash).unwrap(), "\"bash\"");
    }

    #[test]
    fn a_property_change_is_a_type_value_pair() {
        let json = serde_json::to_value(ProcessProperty::Cwd("/tmp".to_owned())).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "cwd", "value": "/tmp" }));

        let json = serde_json::to_value(ProcessProperty::ShellType(None)).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "shellType", "value": null }));
    }
}
