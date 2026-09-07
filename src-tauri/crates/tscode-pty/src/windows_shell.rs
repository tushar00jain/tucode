//! Port of `vs/platform/terminal/node/windowsShellHelper.ts`.
//!
//! On Windows a pty's own process is always the shell that was launched, so the
//! title and shell type have to come from the process *tree*: `pwsh.exe` running
//! `git.exe` should read as git, and `node.exe` running an npm-installed agent
//! CLI should read as that agent. `traverse_tree` is the descent that finds the
//! innermost interesting process, and `shell_type_of` maps its name onto stock's
//! `TerminalShellType`.
//!
//! Stock reads the tree with `@vscode/windows-process-tree`; here it comes from
//! [`crate::ps`], which supplies the same `name` / `commandLine` / `children`.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use regex::Regex;
use tokio::sync::mpsc;

use crate::decorators::{sleep_until, Debounce};
use crate::ps::{list_processes, log_tree_failure, ProcessItem};
use crate::types::TerminalShellType;

/// How long `checkShell` waits before looking, to give the shell time to
/// actually launch a process. Stock notes this can race, and that the race is
/// recovered from when data stops.
const CHECK_SHELL_DELAY: Duration = Duration::from_millis(300);
/// `@debounce(500)` on `checkShell`, which is called on every data event.
const CHECK_SHELL_DEBOUNCE: Duration = Duration::from_millis(500);

const SHELL_EXECUTABLES: &[&str] = &[
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "bash.exe",
    "git-cmd.exe",
    "wsl.exe",
    "ubuntu.exe",
    "ubuntu1804.exe",
    "kali.exe",
    "debian.exe",
    "opensuse-42.exe",
    "sles-12.exe",
    "julia.exe",
    "nu.exe",
    "node.exe",
    "xonsh.exe",
];

fn shell_executable_regexes() -> &'static [Regex] {
    static REGEXES: std::sync::OnceLock<Vec<Regex>> = std::sync::OnceLock::new();
    REGEXES.get_or_init(|| vec![Regex::new(r"^python(\d(\.\d{0,2})?)?\.exe$").unwrap()])
}

/// npm-installed agent CLIs appear in the process tree as plain `node.exe`, so
/// we identify them by matching the package folder in node's command line.
fn node_agent_cli_patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: std::sync::OnceLock<Vec<(Regex, &'static str)>> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (Regex::new(r"(?i)[\\/]claude-code[\\/]").unwrap(), "claude.exe"),
            (Regex::new(r"(?i)[\\/]codex[\\/]").unwrap(), "codex.exe"),
            (Regex::new(r"(?i)[\\/]command-code[\\/]").unwrap(), "commandcode.exe"),
            (Regex::new(r"(?i)[\\/]copilot[\\/]").unwrap(), "copilot.exe"),
            (Regex::new(r"(?i)[\\/]gemini-cli[\\/]").unwrap(), "gemini.exe"),
        ]
    })
}

/// The current shell name and type, shared with the reader that publishes them.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct ShellState {
    shell_type: Option<TerminalShellType>,
    shell_title: String,
}

/// What `TerminalProcess` learns when the innermost shell changes. Stock fires
/// `onShellTypeChanged` and `onShellNameChanged` together, only when the *type*
/// changed, so they are one callback here.
pub type ShellChangeHandler = Box<dyn Fn(Option<TerminalShellType>, String) + Send + Sync>;

/// Watches a Windows pty's process tree for the shell running inside it.
///
/// Dropping it ends its task.
pub struct WindowsShellHelper {
    checks: mpsc::UnboundedSender<()>,
    state: Arc<Mutex<ShellState>>,
}

impl WindowsShellHelper {
    pub fn new(root_process_id: u32, on_change: ShellChangeHandler) -> Self {
        let (checks, receiver) = mpsc::unbounded_channel();
        let state = Arc::new(Mutex::new(ShellState::default()));

        tokio::spawn(run(
            root_process_id,
            receiver,
            Arc::clone(&state),
            on_change,
        ));

        // Stock's `_startMonitoringShell` checks once at construction.
        let _ = checks.send(());

        Self { checks, state }
    }

    /// Port of `checkShell`, debounced. Called on every data event.
    pub fn check_shell(&self) {
        let _ = self.checks.send(());
    }

    pub fn shell_type(&self) -> Option<TerminalShellType> {
        self.state().shell_type
    }

    pub fn shell_title(&self) -> String {
        self.state().shell_title.clone()
    }

    fn state(&self) -> MutexGuard<'_, ShellState> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

async fn run(
    root_process_id: u32,
    mut checks: mpsc::UnboundedReceiver<()>,
    state: Arc<Mutex<ShellState>>,
    on_change: ShellChangeHandler,
) {
    let mut debounce = Debounce::new(CHECK_SHELL_DEBOUNCE);

    loop {
        let deadline = debounce.deadline();
        tokio::select! {
            check = checks.recv() => {
                if check.is_none() {
                    return;
                }
                debounce.trigger();
            }
            () = sleep_until(deadline) => {
                debounce.fire();

                // Wait to give the shell some time to actually launch a process.
                tokio::time::sleep(CHECK_SHELL_DELAY).await;

                let Some(title) = shell_name(root_process_id).await else { continue };
                let shell_type = shell_type_of(&title);

                // Stock fires both events only when the *type* changed, and the
                // lock is released before either.
                let changed = {
                    let mut current = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    let changed = shell_type != current.shell_type;
                    if changed {
                        current.shell_type = shell_type;
                        current.shell_title.clone_from(&title);
                    }
                    changed
                };
                if changed {
                    on_change(shell_type, title);
                }
            }
        }
    }
}

/// Port of `getShellName`: the innermost shell executable running in the
/// terminal. Stock's "prevent multiple requests at once" guard is structural
/// here — one task issues them, one at a time.
async fn shell_name(root_process_id: u32) -> Option<String> {
    let tree = tokio::task::spawn_blocking(move || list_processes(root_process_id)).await;
    match tree {
        Ok(Ok(tree)) => Some(traverse_tree(Some(&tree))),
        Ok(Err(error)) => {
            log_tree_failure("WindowsShellHelper", &error);
            None
        }
        Err(error) => {
            log::debug!("WindowsShellHelper: Fetching process tree panicked: {error}");
            None
        }
    }
}

/// Port of `traverseTree`.
fn traverse_tree(tree: Option<&ProcessItem>) -> String {
    let Some(tree) = tree else {
        return String::new();
    };

    // Detect npm-installed agent CLIs running inside `node.exe` by inspecting
    // the command line passed to Node. Without this we'd treat them as a generic
    // Node shell.
    if tree.name == "node.exe" && !tree.cmd.is_empty() {
        for (regex, executable) in node_agent_cli_patterns() {
            if regex.is_match(&tree.cmd) {
                return (*executable).to_owned();
            }
        }
    }
    if !SHELL_EXECUTABLES.contains(&tree.name.as_str()) {
        return tree.name.clone();
    }
    for regex in shell_executable_regexes() {
        if regex.is_match(&tree.name) {
            return tree.name.clone();
        }
    }
    if !tree.has_children() {
        return tree.name.clone();
    }

    // The favourite child is the first one that is not just hosting a conhost.
    let mut favourite_child = 0;
    while favourite_child < tree.children.len() {
        let child = &tree.children[favourite_child];
        if !child.has_children() {
            break;
        }
        if child.children[0].name != "conhost.exe" {
            break;
        }
        favourite_child += 1;
    }
    if favourite_child >= tree.children.len() {
        return tree.name.clone();
    }
    traverse_tree(Some(&tree.children[favourite_child]))
}

/// Port of `getShellType(executable)`.
pub fn shell_type_of(executable: &str) -> Option<TerminalShellType> {
    let lowered = executable.to_lowercase();
    match lowered.as_str() {
        "cmd.exe" => Some(TerminalShellType::CommandPrompt),
        "powershell.exe" | "pwsh.exe" => Some(TerminalShellType::PowerShell),
        "bash.exe" | "git-cmd.exe" => Some(TerminalShellType::GitBash),
        "julia.exe" => Some(TerminalShellType::Julia),
        "node.exe" => Some(TerminalShellType::Node),
        "nu.exe" => Some(TerminalShellType::NuShell),
        "xonsh.exe" => Some(TerminalShellType::Xonsh),
        "claude.exe" => Some(TerminalShellType::Claude),
        "codex.exe" => Some(TerminalShellType::Codex),
        "commandcode.exe" => Some(TerminalShellType::CommandCode),
        "copilot.exe" => Some(TerminalShellType::Copilot),
        "gemini.exe" => Some(TerminalShellType::Gemini),
        "wsl.exe" | "ubuntu.exe" | "ubuntu1804.exe" | "kali.exe" | "debian.exe"
        | "opensuse-42.exe" | "sles-12.exe" => Some(TerminalShellType::Wsl),
        _ => python_regex()
            .is_match(&lowered)
            .then_some(TerminalShellType::Python),
    }
}

/// Stock's default arm matches without anchors, so `python3.11.exe` inside a
/// longer name still counts.
fn python_regex() -> &'static Regex {
    static REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"python(\d(\.\d{0,2})?)?\.exe").unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str, cmd: &str, children: Vec<ProcessItem>) -> ProcessItem {
        ProcessItem {
            name: name.to_owned(),
            cmd: cmd.to_owned(),
            pid: 1,
            ppid: 0,
            children,
        }
    }

    #[test]
    fn a_leaf_shell_is_its_own_name() {
        let tree = node("pwsh.exe", "pwsh.exe", vec![]);
        assert_eq!(traverse_tree(Some(&tree)), "pwsh.exe");
    }

    #[test]
    fn a_non_shell_child_wins_over_the_shell_that_launched_it() {
        let tree = node("pwsh.exe", "pwsh.exe", vec![node("git.exe", "git status", vec![])]);
        assert_eq!(traverse_tree(Some(&tree)), "git.exe");
    }

    #[test]
    fn a_child_that_only_hosts_a_conhost_is_skipped() {
        let tree = node(
            "cmd.exe",
            "cmd.exe",
            vec![
                node("bash.exe", "bash", vec![node("conhost.exe", "conhost", vec![])]),
                node("git.exe", "git status", vec![]),
            ],
        );
        assert_eq!(traverse_tree(Some(&tree)), "git.exe");
    }

    #[test]
    fn an_agent_cli_running_under_node_is_named_by_its_package() {
        let tree = node(
            "node.exe",
            r"node.exe C:\npm\node_modules\@anthropic-ai\claude-code\cli.js",
            vec![],
        );
        assert_eq!(traverse_tree(Some(&tree)), "claude.exe");
        assert_eq!(shell_type_of("claude.exe"), Some(TerminalShellType::Claude));
    }

    #[test]
    fn a_plain_node_is_still_node() {
        let tree = node("node.exe", "node.exe server.js", vec![]);
        assert_eq!(traverse_tree(Some(&tree)), "node.exe");
        assert_eq!(shell_type_of("node.exe"), Some(TerminalShellType::Node));
    }

    #[test]
    fn python_is_matched_with_and_without_a_version() {
        assert_eq!(shell_type_of("python.exe"), Some(TerminalShellType::Python));
        assert_eq!(shell_type_of("python3.exe"), Some(TerminalShellType::Python));
        assert_eq!(shell_type_of("Python3.11.exe"), Some(TerminalShellType::Python));
        assert_eq!(shell_type_of("pythonw.exe"), None);
    }

    #[test]
    fn every_wsl_launcher_maps_to_wsl() {
        for name in ["wsl.exe", "ubuntu.exe", "debian.exe", "sles-12.exe"] {
            assert_eq!(shell_type_of(name), Some(TerminalShellType::Wsl), "{name}");
        }
    }

    #[test]
    fn an_unknown_executable_has_no_shell_type() {
        assert_eq!(shell_type_of("git.exe"), None);
    }
}
