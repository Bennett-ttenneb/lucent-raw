//! Performance settings: how many worker threads previews, exports, face finding and enlarging may use.
//! There is no GPU path in the program, so there is no GPU switch; the number of threads is the one thing that can be tuned.
//! The choice is kept by the window (it is sent here at start-up and when it changes); 0 means "let the program decide".

use std::sync::atomic::{AtomicUsize, Ordering};

static LIMIT: AtomicUsize = AtomicUsize::new(0);

/// The most threads that can be asked for.
pub const MAX_THREADS: usize = 32;

/// How many logical processors this computer has.
pub fn cores() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2)
}

/// Set the limit: 0 for automatic, otherwise 1 to `MAX_THREADS`. Returns what is now in force.
pub fn set(threads: usize) -> usize {
    let v = threads.min(MAX_THREADS);
    LIMIT.store(v, Ordering::Relaxed);
    v
}

pub fn limit() -> usize {
    LIMIT.load(Ordering::Relaxed)
}

/// The number of worker threads to use. Automatic: all the processors up to 8, or (`leave_one`, for work that runs while the window
/// is in use) all but one, up to 8. A chosen limit is used as it is.
pub fn threads(leave_one: bool) -> usize {
    match limit() {
        0 => {
            let n = cores();
            if leave_one {
                n.saturating_sub(1).max(1).min(8)
            } else {
                n.clamp(1, 8)
            }
        }
        chosen => chosen,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_follows_the_processors_and_a_chosen_limit_wins() {
        set(0);
        assert!((1..=8).contains(&threads(false)));
        assert!((1..=8).contains(&threads(true)));
        assert!(threads(true) <= threads(false));
        assert_eq!(set(3), 3);
        assert_eq!((threads(false), threads(true)), (3, 3));
        assert_eq!(set(500), MAX_THREADS, "more than the most is held to the most");
        set(0);
    }
}
