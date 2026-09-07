//! Port of stock `BatchedCollector` from
//! `vs/workbench/services/search/common/textSearchManager.ts`.
//!
//! The first `START_BATCH_AFTER_COUNT` matches flush immediately so the view
//! fills instantly; after that results are batched to `max_batch_size`, with a
//! timeout flush so a slow tail still lands. The one deviation from stock is
//! mechanical: JS uses `setTimeout`, we expose the deadline and let the draining
//! thread block on it with `recv_timeout`.

use std::time::{Duration, Instant};

/// Stock `SearchService.BATCH_SIZE` / `TextSearchResultsCollector`'s collector.
pub const MAX_BATCH_SIZE: usize = 512;
const START_BATCH_AFTER_COUNT: usize = 50;
const TIMEOUT: Duration = Duration::from_millis(4000);

pub struct BatchedCollector<T, F: FnMut(Vec<T>)> {
    max_batch_size: usize,
    cb: F,
    total_number_completed: usize,
    batch: Vec<T>,
    batch_size: usize,
    timeout_deadline: Option<Instant>,
}

impl<T, F: FnMut(Vec<T>)> BatchedCollector<T, F> {
    pub fn new(max_batch_size: usize, cb: F) -> Self {
        Self {
            max_batch_size,
            cb,
            total_number_completed: 0,
            batch: Vec::new(),
            batch_size: 0,
            timeout_deadline: None,
        }
    }

    /// `size` weights the item — for a file match it is the number of matches in
    /// the file, so the batch is capped by matches rather than by files.
    pub fn add_item(&mut self, item: T, size: usize) {
        self.batch.push(item);
        self.batch_size += size;
        self.on_update();
    }

    fn on_update(&mut self) {
        if self.total_number_completed < START_BATCH_AFTER_COUNT {
            self.flush();
        } else if self.batch_size >= self.max_batch_size {
            self.flush();
        } else if self.timeout_deadline.is_none() {
            self.timeout_deadline = Some(Instant::now() + TIMEOUT);
        }
    }

    pub fn flush(&mut self) {
        if self.batch_size == 0 {
            return;
        }
        self.total_number_completed += self.batch_size;
        (self.cb)(std::mem::take(&mut self.batch));
        self.batch_size = 0;
        self.timeout_deadline = None;
    }

    /// When a timeout flush is pending, the instant it is due.
    pub fn timeout_deadline(&self) -> Option<Instant> {
        self.timeout_deadline
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn flushes_every_item_until_the_batching_threshold_then_batches() {
        let flushes: RefCell<Vec<usize>> = RefCell::new(Vec::new());
        {
            let mut collector =
                BatchedCollector::new(MAX_BATCH_SIZE, |items: Vec<u32>| flushes.borrow_mut().push(items.len()));
            // 50 single-match items: each flushes on its own.
            for i in 0..START_BATCH_AFTER_COUNT {
                collector.add_item(i as u32, 1);
            }
            // Past the threshold, items accumulate until the batch is full.
            for i in 0..MAX_BATCH_SIZE {
                collector.add_item(i as u32, 1);
            }
        }
        let flushes = flushes.into_inner();
        assert_eq!(flushes.len(), START_BATCH_AFTER_COUNT + 1);
        assert!(flushes[..START_BATCH_AFTER_COUNT].iter().all(|&n| n == 1));
        assert_eq!(flushes[START_BATCH_AFTER_COUNT], MAX_BATCH_SIZE);
    }

    #[test]
    fn empty_flush_does_not_invoke_the_callback() {
        let mut calls = 0;
        let mut collector = BatchedCollector::new(MAX_BATCH_SIZE, |_: Vec<u32>| calls += 1);
        collector.flush();
        collector.flush();
        drop(collector);
        assert_eq!(calls, 0);
    }
}
