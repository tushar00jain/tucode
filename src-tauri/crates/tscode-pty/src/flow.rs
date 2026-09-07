//! Flow control, ported from the `_unacknowledgedCharCount` half of
//! `vs/platform/terminal/node/terminalProcess.ts`
//! (`ptyProcess.onData`, `acknowledgeDataEvent`, `clearUnacknowledgedChars`).
//!
//! The contract is symmetric and unforgiving: the frontend acks every
//! [`CHAR_COUNT_ACK_SIZE`](crate::types::flow_control::CHAR_COUNT_ACK_SIZE)
//! characters it has parsed, and the pty pauses above
//! [`HIGH_WATERMARK_CHARS`](crate::types::flow_control::HIGH_WATERMARK_CHARS)
//! and resumes below
//! [`LOW_WATERMARK_CHARS`](crate::types::flow_control::LOW_WATERMARK_CHARS).
//! Getting either threshold wrong deadlocks the terminal instead of failing
//! loudly, so all three constants live in one place and are read from there.
//!
//! Where stock calls `node-pty`'s `pause()` / `resume()` — which stop reading the
//! master fd and let the OS pipe buffer apply backpressure to the child — this
//! parks the reader thread before its next `read`, which is the same mechanism.
//!
//! Character counts are UTF-16 code units, because the frontend acks with
//! JavaScript's `string.length`.

use std::sync::{Condvar, Mutex, MutexGuard};

use crate::types::flow_control::{HIGH_WATERMARK_CHARS, LOW_WATERMARK_CHARS};

#[derive(Debug, Default)]
struct FlowState {
    unacknowledged: usize,
    paused: bool,
    /// Set when the process is torn down, so a parked reader wakes and stops
    /// rather than waiting for an ack that will never arrive.
    disposed: bool,
}

/// The unacknowledged-character window for one pty.
#[derive(Debug, Default)]
pub struct FlowControl {
    state: Mutex<FlowState>,
    resumed: Condvar,
}

impl FlowControl {
    pub fn new() -> Self {
        Self::default()
    }

    /// The number of UTF-16 code units in a chunk, which is what the frontend
    /// will ack for it.
    pub fn char_count(data: &str) -> usize {
        data.encode_utf16().count()
    }

    /// Called by the reader thread before each read. Blocks while paused and
    /// returns `false` once the process has been disposed.
    pub fn wait_until_resumed(&self) -> bool {
        let mut state = self.lock();
        while state.paused && !state.disposed {
            state = self
                .resumed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        !state.disposed
    }

    /// Port of the flow-control block at the top of `ptyProcess.onData`.
    pub fn on_data(&self, char_count: usize) {
        let mut state = self.lock();
        state.unacknowledged += char_count;
        if !state.paused && state.unacknowledged > HIGH_WATERMARK_CHARS {
            log::trace!(
                "Flow control: Pause ({} > {HIGH_WATERMARK_CHARS})",
                state.unacknowledged
            );
            state.paused = true;
        }
    }

    /// Port of `acknowledgeDataEvent`.
    pub fn acknowledge(&self, char_count: usize) {
        let mut state = self.lock();
        // Prevent lower than 0 to heal from errors
        state.unacknowledged = state.unacknowledged.saturating_sub(char_count);
        log::trace!(
            "Flow control: Ack {char_count} chars (unacknowledged: {})",
            state.unacknowledged
        );
        if state.paused && state.unacknowledged < LOW_WATERMARK_CHARS {
            log::trace!(
                "Flow control: Resume ({} < {LOW_WATERMARK_CHARS})",
                state.unacknowledged
            );
            state.paused = false;
            self.resumed.notify_all();
        }
    }

    /// Port of `clearUnacknowledgedChars`.
    pub fn clear_unacknowledged(&self) {
        let mut state = self.lock();
        state.unacknowledged = 0;
        log::trace!("Flow control: Cleared all unacknowledged chars, forcing resume");
        if state.paused {
            state.paused = false;
            self.resumed.notify_all();
        }
    }

    /// The process is gone. Releases a parked reader.
    pub fn dispose(&self) {
        let mut state = self.lock();
        state.disposed = true;
        state.paused = false;
        self.resumed.notify_all();
    }

    pub fn is_paused(&self) -> bool {
        self.lock().paused
    }

    pub fn unacknowledged(&self) -> usize {
        self.lock().unacknowledged
    }

    fn lock(&self) -> MutexGuard<'_, FlowState> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::flow_control::CHAR_COUNT_ACK_SIZE;

    #[test]
    fn the_ack_size_can_never_strand_a_paused_terminal() {
        // Stock states this invariant in `FlowControlConstants`: an ack larger
        // than the low watermark would never bring the count below it.
        assert!(CHAR_COUNT_ACK_SIZE <= LOW_WATERMARK_CHARS);
    }

    #[test]
    fn the_pty_pauses_only_above_the_high_watermark() {
        let flow = FlowControl::new();

        flow.on_data(HIGH_WATERMARK_CHARS);
        assert!(!flow.is_paused(), "equal to the watermark is not above it");

        flow.on_data(1);
        assert!(flow.is_paused());
        assert_eq!(flow.unacknowledged(), HIGH_WATERMARK_CHARS + 1);
    }

    #[test]
    fn a_paused_pty_resumes_only_below_the_low_watermark() {
        let flow = FlowControl::new();
        flow.on_data(HIGH_WATERMARK_CHARS + 1);
        assert!(flow.is_paused());

        // Down to exactly the low watermark: still paused.
        flow.acknowledge(HIGH_WATERMARK_CHARS + 1 - LOW_WATERMARK_CHARS);
        assert_eq!(flow.unacknowledged(), LOW_WATERMARK_CHARS);
        assert!(flow.is_paused());

        flow.acknowledge(1);
        assert!(!flow.is_paused());
    }

    #[test]
    fn an_over_large_ack_heals_rather_than_underflowing() {
        let flow = FlowControl::new();
        flow.on_data(10);
        flow.acknowledge(1000);
        assert_eq!(flow.unacknowledged(), 0);
    }

    #[test]
    fn clearing_forces_a_resume() {
        let flow = FlowControl::new();
        flow.on_data(HIGH_WATERMARK_CHARS + 1);
        assert!(flow.is_paused());

        flow.clear_unacknowledged();
        assert_eq!(flow.unacknowledged(), 0);
        assert!(!flow.is_paused());
    }

    #[test]
    fn a_resumed_reader_is_not_blocked() {
        let flow = FlowControl::new();
        assert!(flow.wait_until_resumed());
    }

    #[test]
    fn disposing_releases_a_parked_reader() {
        let flow = std::sync::Arc::new(FlowControl::new());
        flow.on_data(HIGH_WATERMARK_CHARS + 1);
        assert!(flow.is_paused());

        let reader = {
            let flow = std::sync::Arc::clone(&flow);
            std::thread::spawn(move || flow.wait_until_resumed())
        };
        flow.dispose();
        assert!(!reader.join().unwrap(), "a disposed process stops the reader");
    }

    #[test]
    fn char_count_is_utf16_code_units_as_the_client_acks_them() {
        // The client acks with JavaScript's `string.length`, so an astral
        // character counts as its surrogate pair.
        assert_eq!(FlowControl::char_count("abc"), 3);
        assert_eq!(FlowControl::char_count("\u{2764}"), 1);
        assert_eq!(FlowControl::char_count("\u{1F600}"), 2);
    }
}
