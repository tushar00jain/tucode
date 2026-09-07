//! Port of `vs/platform/terminal/node/childProcessMonitor.ts`.
//!
//! Answers `ProcessPropertyType.HasChildProcesses`, which the frontend uses to
//! decide whether closing a terminal needs a confirmation prompt. The whole file
//! is about *when* to look: walking the process tree is expensive, so input
//! (the user pressed enter — something is about to start) debounces a check, and
//! output (something is running) throttles one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::decorators::{sleep_until, Debounce, Throttle};
use crate::ps::{list_processes, ProcessItem};
use crate::types::node_stem;

/// The amount of time to throttle checks when the process receives output.
const INACTIVE_THROTTLE_DURATION: Duration = Duration::from_millis(5000);
/// The amount of time to debounce a check when the process receives input.
const ACTIVE_DEBOUNCE_DURATION: Duration = Duration::from_millis(1000);

/// Stock's `ignoreProcessNames`, empty upstream. A single child whose name is
/// listed here does not count as a child process.
const IGNORE_PROCESS_NAMES: &[&str] = &[];

/// What the monitor is told about the process it watches.
enum Signal {
    Input,
    Output,
    SetPid(u32),
}

/// Monitors a process for child processes, checking at differing times depending
/// on input and output calls into the monitor.
///
/// Dropping it ends its task.
pub struct ChildProcessMonitor {
    signals: mpsc::UnboundedSender<Signal>,
    has_child_processes: Arc<AtomicBool>,
}

impl ChildProcessMonitor {
    /// `on_change` is stock's `onDidChangeHasChildProcesses`; it fires only when
    /// the value actually changes.
    pub fn new(pid: u32, on_change: impl Fn(bool) + Send + Sync + 'static) -> Self {
        let (signals, receiver) = mpsc::unbounded_channel();
        let has_child_processes = Arc::new(AtomicBool::new(false));

        tokio::spawn(run(
            pid,
            receiver,
            Arc::clone(&has_child_processes),
            Box::new(on_change),
        ));

        Self {
            signals,
            has_child_processes,
        }
    }

    /// Input was triggered on the process.
    pub fn handle_input(&self) {
        let _ = self.signals.send(Signal::Input);
    }

    /// Output was triggered on the process.
    pub fn handle_output(&self) {
        let _ = self.signals.send(Signal::Output);
    }

    /// Updates the pid to monitor.
    pub fn set_pid(&self, pid: u32) {
        let _ = self.signals.send(Signal::SetPid(pid));
    }

    /// Whether the process has child processes.
    pub fn has_child_processes(&self) -> bool {
        self.has_child_processes.load(Ordering::Acquire)
    }
}

type ChangeHandler = Box<dyn Fn(bool) + Send + Sync>;

async fn run(
    mut pid: u32,
    mut signals: mpsc::UnboundedReceiver<Signal>,
    has_child_processes: Arc<AtomicBool>,
    on_change: ChangeHandler,
) {
    // `_refreshActive` is debounced; `_refreshInactive` is a throttle in front of
    // it, so output refreshes at most once per window and still waits for the
    // debounce.
    let mut active = Debounce::new(ACTIVE_DEBOUNCE_DURATION);
    let mut inactive = Throttle::new(INACTIVE_THROTTLE_DURATION);

    loop {
        let active_deadline = active.deadline();
        let inactive_deadline = inactive.deadline();

        tokio::select! {
            signal = signals.recv() => {
                let Some(signal) = signal else { return };
                match signal {
                    Signal::Input => active.trigger(),
                    Signal::Output => if inactive.trigger() { active.trigger(); },
                    Signal::SetPid(new_pid) => pid = new_pid,
                }
            }
            () = sleep_until(active_deadline) => {
                active.fire();
                refresh(pid, &has_child_processes, &on_change).await;
            }
            () = sleep_until(inactive_deadline) => {
                if inactive.fire() {
                    active.trigger();
                }
            }
        }
    }
}

/// Port of `_refreshActive`.
async fn refresh(pid: u32, has_child_processes: &AtomicBool, on_change: &ChangeHandler) {
    let tree = tokio::task::spawn_blocking(move || list_processes(pid)).await;
    match tree {
        Ok(Ok(item)) => {
            let value = process_contains_children(&item);
            if has_child_processes.swap(value, Ordering::AcqRel) != value {
                log::debug!("ChildProcessMonitor: Has child processes changed {value}");
                on_change(value);
            }
        }
        Ok(Err(error)) => {
            log::debug!("ChildProcessMonitor: Fetching process tree failed: {error}");
        }
        Err(error) => log::debug!("ChildProcessMonitor: Fetching process tree panicked: {error}"),
    }
}

/// Port of `_processContainsChildren`.
fn process_contains_children(process_item: &ProcessItem) -> bool {
    // No child processes
    if !process_item.has_children() {
        return false;
    }

    // A single child process, handle special cases
    if process_item.children.len() == 1 {
        let item = &process_item.children[0];
        let cmd = if let Some(rest) = item.cmd.strip_prefix('"') {
            rest.find('"').map_or_else(String::new, |end| rest[..end].to_owned())
        } else {
            match item.cmd.find(' ') {
                None => item.cmd.clone(),
                Some(space_index) => item.cmd[..space_index].to_owned(),
            }
        };
        return !IGNORE_PROCESS_NAMES.contains(&node_stem(&cmd).as_str());
    }

    // Fallback, count child processes
    !process_item.children.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(cmd: &str, children: Vec<ProcessItem>) -> ProcessItem {
        ProcessItem {
            name: cmd.to_owned(),
            cmd: cmd.to_owned(),
            pid: 1,
            ppid: 0,
            children,
        }
    }

    #[test]
    fn a_shell_with_no_children_has_none() {
        assert!(!process_contains_children(&item("pwsh.exe", vec![])));
    }

    #[test]
    fn a_single_child_counts_unless_its_name_is_ignored() {
        let tree = item("pwsh.exe", vec![item("git.exe status", vec![])]);
        assert!(process_contains_children(&tree));
    }

    #[test]
    fn a_quoted_single_child_command_is_unwrapped_before_matching() {
        // The name extracted here is what the ignore list is compared against;
        // an unbalanced quote must not panic or swallow the rest of the line.
        let tree = item("pwsh.exe", vec![item("\"C:\\Program Files\\git.exe\" status", vec![])]);
        assert!(process_contains_children(&tree));

        let tree = item("pwsh.exe", vec![item("\"unterminated", vec![])]);
        assert!(process_contains_children(&tree));
    }

    #[test]
    fn several_children_always_count() {
        let tree = item(
            "pwsh.exe",
            vec![item("conhost.exe", vec![]), item("git.exe", vec![])],
        );
        assert!(process_contains_children(&tree));
    }
}
