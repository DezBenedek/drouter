use std::time::{Duration, Instant};
pub struct Watchdog {
    last_progress: Instant,
    timeout: Duration,
}
impl Watchdog {
    pub fn new(timeout: Duration) -> Self {
        Self {
            last_progress: Instant::now(),
            timeout,
        }
    }
    pub fn feed(&mut self) {
        self.last_progress = Instant::now();
    }
    pub fn healthy(&self) -> bool {
        self.last_progress.elapsed() < self.timeout
    }
}
