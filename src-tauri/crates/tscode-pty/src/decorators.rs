//! Port of the `@debounce(delay)` and `@throttle(delay)` decorators in
//! `vs/base/common/decorators.ts`.
//!
//! `childProcessMonitor.ts` and `windowsShellHelper.ts` both lean on their exact
//! timing — a debounced refresh that only runs once the caller goes quiet, and a
//! throttled one that runs immediately and then at most once per window. Both
//! are ported here rather than in each caller, so the two have one definition
//! between them.
//!
//! Rust has no decorators, so the shape is inverted: the caller owns the timer
//! state and asks it when to wake. A caller drives one from a `tokio::select!`
//! loop — [`deadline`](Debounce::deadline) is the branch's precondition, and
//! `fire` is what the branch calls when the sleep completes.

use std::time::Duration;

use tokio::time::Instant;

/// Sleep until an optional deadline. `tokio::select!` needs a future in every
/// branch, and a disarmed timer is one that never completes.
pub async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Port of `@debounce(delay)`: each call restarts the timer, and the body runs
/// once `delay` has passed with no further call.
#[derive(Debug)]
pub struct Debounce {
    delay: Duration,
    deadline: Option<Instant>,
}

impl Debounce {
    pub fn new(delay: Duration) -> Self {
        Self {
            delay,
            deadline: None,
        }
    }

    /// A call arrived.
    pub fn trigger(&mut self) {
        self.deadline = Some(Instant::now() + self.delay);
    }

    /// When the caller should wake, if the timer is armed.
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// The timer elapsed: disarm it. The caller runs the body.
    pub fn fire(&mut self) {
        self.deadline = None;
    }
}

/// Port of `@throttle(delay)`: the first call runs immediately and opens a
/// window; calls during the window are coalesced into one run at its end.
#[derive(Debug)]
pub struct Throttle {
    delay: Duration,
    window_end: Option<Instant>,
    pending: bool,
}

impl Throttle {
    pub fn new(delay: Duration) -> Self {
        Self {
            delay,
            window_end: None,
            pending: false,
        }
    }

    /// A call arrived. Returns whether the body should run now.
    pub fn trigger(&mut self) -> bool {
        if self.window_end.is_some() {
            self.pending = true;
            return false;
        }
        self.open_window();
        true
    }

    /// When the caller should wake, if a window is open.
    pub fn deadline(&self) -> Option<Instant> {
        self.window_end
    }

    /// The window elapsed. Returns whether a coalesced call should run now,
    /// which re-opens the window exactly as a leading call would.
    pub fn fire(&mut self) -> bool {
        self.window_end = None;
        if !self.pending {
            return false;
        }
        self.pending = false;
        self.open_window();
        true
    }

    fn open_window(&mut self) {
        self.window_end = Some(Instant::now() + self.delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_debounce_is_armed_by_a_call_and_disarmed_by_firing() {
        let mut debounce = Debounce::new(Duration::from_millis(10));
        assert!(debounce.deadline().is_none());

        debounce.trigger();
        let first = debounce.deadline().expect("armed");

        debounce.trigger();
        assert!(debounce.deadline().expect("re-armed") >= first);

        debounce.fire();
        assert!(debounce.deadline().is_none());
    }

    #[test]
    fn a_throttle_runs_the_leading_call_immediately() {
        let mut throttle = Throttle::new(Duration::from_millis(10));
        assert!(throttle.trigger());
        assert!(throttle.deadline().is_some());
    }

    #[test]
    fn calls_inside_the_window_coalesce_into_one_trailing_run() {
        let mut throttle = Throttle::new(Duration::from_millis(10));
        assert!(throttle.trigger());
        assert!(!throttle.trigger());
        assert!(!throttle.trigger());

        // One trailing run, which re-opens the window.
        assert!(throttle.fire());
        assert!(throttle.deadline().is_some());

        // Nothing arrived during the second window, so it closes quietly.
        assert!(!throttle.fire());
        assert!(throttle.deadline().is_none());
    }
}
