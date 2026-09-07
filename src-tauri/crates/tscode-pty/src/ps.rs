//! Port of `vs/base/node/ps.ts` (`listProcesses`) onto `sysinfo`.
//!
//! Stock has two implementations behind one function: `@vscode/windows-process-tree`
//! on Windows, and `ps -ax -o pid=,ppid=,pcpu=,pmem=,command=` parsed by
//! `parsePsOutput` everywhere else. `sysinfo` reads the same two sources
//! (`NtQuerySystemInformation` / `/proc` / `sysctl`) in-process, so the port is
//! one implementation where stock has two, and neither shells out.
//!
//! # Deliberate deviations from the reference implementation
//!
//! - **No `load` or `mem`.** Stock collects CPU and memory per process for the
//!   process explorer, which this app does not ship. `hasChildProcesses` and the
//!   Windows shell-type walk — the only two consumers below
//!   `ITerminalChildProcess` — read `name`, `cmd` and `children` only.
//! - **No `findName`.** It rewrites Electron's own process names
//!   (`--type=renderer` becomes `window`, `conhost --headless` becomes
//!   `conpty-agent`) for that same explorer. `name` here is the executable name,
//!   which is what `windowsShellHelper.ts` matches against and what
//!   `@vscode/windows-process-tree` supplies it with.

use std::collections::HashMap;

use sysinfo::{Pid, ProcessesToUpdate, Signal, System};

use crate::error::{PtyError, Result};

/// Stock `ProcessItem` from `vs/base/common/processes.ts`, less the fields the
/// process explorer owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessItem {
    /// The executable's file name, e.g. `pwsh.exe`.
    pub name: String,
    /// The full command line.
    pub cmd: String,
    pub pid: u32,
    pub ppid: u32,
    /// Sorted by pid, as stock sorts its children.
    pub children: Vec<ProcessItem>,
}

impl ProcessItem {
    /// Stock leaves `children` unset rather than empty, and
    /// `childProcessMonitor.ts` branches on that. An empty list is the same
    /// thing.
    pub fn has_children(&self) -> bool {
        !self.children.is_empty()
    }
}

/// Port of `listProcesses(rootPid)`: the tree rooted at `root_pid`.
///
/// Blocking: enumerates every process on the machine. Callers run it inside
/// `spawn_blocking`.
pub fn list_processes(root_pid: u32) -> Result<ProcessItem> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let rows = snapshot(&system);
    build_tree(&rows, &children_by_parent(&rows), root_pid)
        .ok_or(PtyError::NoSuchProcess(root_pid))
}

/// The name of one process, which is `node-pty`'s `IPty.process` — on Unix, the
/// pty's foreground process group leader; on Windows, the pty's own child.
///
/// Blocking. Callers run it inside `spawn_blocking`, or accept the cost of a
/// single-pid refresh on the title poll.
pub fn process_name(pid: u32) -> Option<String> {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system
        .process(pid)
        .map(|process| process.name().to_string_lossy().into_owned())
}

/// Port of `node-pty`'s `IPty.kill(signal)`, which `TerminalProcess.sendSignal`
/// calls. Errors are swallowed there too: the process may already be gone, and a
/// signal that could not be delivered is not something the frontend can act on.
pub fn send_signal(pid: u32, signal: &str) {
    let Some(signal) = parse_signal(signal) else {
        log::trace!("sendSignal: unknown signal {signal}");
        return;
    };

    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    match system.process(pid) {
        Some(process) => {
            if process.kill_with(signal).is_none() {
                log::trace!("sendSignal: {signal:?} is not supported on this platform");
            }
        }
        None => log::trace!("sendSignal: process {pid} is gone"),
    }
}

/// Signal names as the frontend spells them, with or without the `SIG` prefix.
fn parse_signal(signal: &str) -> Option<Signal> {
    let name = signal.to_uppercase();
    let name = name.strip_prefix("SIG").unwrap_or(&name);
    Some(match name {
        "HUP" => Signal::Hangup,
        "INT" => Signal::Interrupt,
        "QUIT" => Signal::Quit,
        "ABRT" => Signal::Abort,
        "KILL" => Signal::Kill,
        "ALRM" => Signal::Alarm,
        "TERM" => Signal::Term,
        "USR1" => Signal::User1,
        "USR2" => Signal::User2,
        "PIPE" => Signal::Pipe,
        "CONT" => Signal::Continue,
        "STOP" => Signal::Stop,
        "TSTP" => Signal::TSTP,
        "TTIN" => Signal::TTIN,
        "TTOU" => Signal::TTOU,
        "WINCH" => Signal::Winch,
        _ => return None,
    })
}

/// One flat row per process, which is what both of stock's backends produce
/// before it assembles the tree.
struct ProcessRow {
    name: String,
    cmd: String,
    ppid: u32,
}

fn snapshot(system: &System) -> HashMap<u32, ProcessRow> {
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            let cmd = process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let row = ProcessRow {
                name: process.name().to_string_lossy().into_owned(),
                // Stock's `cmd` is the whole command line; a process whose argv
                // is unreadable still has an executable path.
                cmd: if cmd.is_empty() {
                    process
                        .exe()
                        .map(|exe| exe.to_string_lossy().into_owned())
                        .unwrap_or_default()
                } else {
                    cmd
                },
                ppid: process.parent().map_or(0, Pid::as_u32),
            };
            (pid.as_u32(), row)
        })
        .collect()
}

/// One pass over the flat rows, so assembling the tree is linear rather than a
/// scan per node.
fn children_by_parent(rows: &HashMap<u32, ProcessRow>) -> HashMap<u32, Vec<u32>> {
    let mut index: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, row) in rows {
        // A process that reports itself as its own parent would recurse forever.
        if row.ppid != *pid {
            index.entry(row.ppid).or_default().push(*pid);
        }
    }
    for children in index.values_mut() {
        children.sort_unstable();
    }
    index
}

/// Stock's `addToTree`: only processes reachable from `rootPid` are kept, and
/// each node's children are sorted by pid.
fn build_tree(
    rows: &HashMap<u32, ProcessRow>,
    index: &HashMap<u32, Vec<u32>>,
    pid: u32,
) -> Option<ProcessItem> {
    let row = rows.get(&pid)?;
    Some(ProcessItem {
        name: row.name.clone(),
        cmd: row.cmd.clone(),
        pid,
        ppid: row.ppid,
        children: index
            .get(&pid)
            .into_iter()
            .flatten()
            .filter_map(|child| build_tree(rows, index, *child))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, cmd: &str, ppid: u32) -> ProcessRow {
        ProcessRow {
            name: name.to_owned(),
            cmd: cmd.to_owned(),
            ppid,
        }
    }

    #[test]
    fn a_tree_holds_only_what_the_root_reaches() {
        let rows: HashMap<u32, ProcessRow> = [
            (1, row("init", "init", 0)),
            (10, row("pwsh.exe", "pwsh.exe", 1)),
            (12, row("git.exe", "git.exe status", 10)),
            (11, row("conhost.exe", "conhost.exe --headless", 10)),
            (20, row("other.exe", "other.exe", 1)),
        ]
        .into();

        let tree = build_tree(&rows, &children_by_parent(&rows), 10).unwrap();
        assert_eq!(tree.name, "pwsh.exe");
        // Sorted by pid, as stock sorts children.
        assert_eq!(
            tree.children.iter().map(|child| child.pid).collect::<Vec<_>>(),
            vec![11, 12]
        );
        assert!(!tree.children[0].has_children());
    }

    #[test]
    fn a_leaf_has_no_children() {
        let rows: HashMap<u32, ProcessRow> = [(7, row("sh", "sh", 1))].into();
        let tree = build_tree(&rows, &children_by_parent(&rows), 7).unwrap();
        assert!(!tree.has_children());
        assert_eq!(tree.ppid, 1);
    }

    #[test]
    fn signal_names_are_read_with_or_without_the_prefix() {
        assert_eq!(parse_signal("SIGINT"), Some(Signal::Interrupt));
        assert_eq!(parse_signal("int"), Some(Signal::Interrupt));
        assert_eq!(parse_signal("SIGKILL"), Some(Signal::Kill));
        assert_eq!(parse_signal("SIGNOPE"), None);
    }

    #[test]
    fn an_unknown_root_is_not_found() {
        let rows: HashMap<u32, ProcessRow> = [(7, row("sh", "sh", 1))].into();
        assert!(build_tree(&rows, &children_by_parent(&rows), 99).is_none());
    }
}
