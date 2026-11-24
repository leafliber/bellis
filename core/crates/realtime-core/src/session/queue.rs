//! 非阻塞通知发送队列：锁内或读线程/钩子线程产生的通知入队后由专用发送线程写出。

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

type Item = (&'static str, Map<String, Value>);

#[derive(Default)]
struct Inner {
    items: VecDeque<Item>,
    sending: bool,
    closed: bool,
}

/// 多生产者、单发送线程的通知队列。
#[derive(Default)]
pub(crate) struct SendQueue {
    inner: Mutex<Inner>,
    changed: Condvar,
}

impl SendQueue {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 放进一条通知并立即返回；关闭后放进的丢弃。
    pub(crate) fn push(&self, method: &'static str, params: Map<String, Value>) {
        let mut inner = self.lock();
        if inner.closed {
            return;
        }
        inner.items.push_back((method, params));
        drop(inner);
        self.changed.notify_all();
    }

    /// 发送线程循环：逐条交给 `send`，直到关闭。
    pub(crate) fn run(&self, mut send: impl FnMut(&'static str, &Map<String, Value>)) {
        let mut inner = self.lock();
        loop {
            if let Some((method, params)) = inner.items.pop_front() {
                inner.sending = true;
                drop(inner);
                send(method, &params);
                inner = self.lock();
                inner.sending = false;
                self.changed.notify_all();
                continue;
            }
            if inner.closed {
                return;
            }
            inner = self
                .changed
                .wait(inner)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// 等待此前放进的全部写出，至多 `timeout`；返回是否已全部写出。
    pub(crate) fn flush(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock();
        while !inner.items.is_empty() || inner.sending {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            inner = self
                .changed
                .wait_timeout(inner, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }

    /// 关闭并丢弃队列中剩余项，发送线程写完当前项后退出。
    pub(crate) fn abandon(&self) {
        let mut inner = self.lock();
        inner.closed = true;
        inner.items.clear();
        drop(inner);
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier, mpsc};
    use std::thread;
    use std::time::Duration;

    use serde_json::Map;

    use super::SendQueue;

    #[test]
    fn sends_in_order_and_flush_waits() {
        let queue = Arc::new(SendQueue::default());
        let (sent, received) = mpsc::channel();
        let gate = Arc::new(Barrier::new(2));
        let sender = thread::spawn({
            let (queue, gate) = (Arc::clone(&queue), Arc::clone(&gate));
            move || {
                gate.wait();
                queue.run(|method, _| sent.send(method).unwrap());
            }
        });
        queue.push("a", Map::new());
        queue.push("b", Map::new());
        assert!(!queue.flush(Duration::from_millis(20)));
        gate.wait();
        assert!(queue.flush(Duration::from_secs(5)));
        assert_eq!(received.try_iter().collect::<Vec<_>>(), ["a", "b"]);
        queue.abandon();
        queue.push("after-close", Map::new());
        sender.join().unwrap();
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn abandon_drops_remaining_items() {
        let queue = SendQueue::default();
        queue.push("a", Map::new());
        queue.abandon();
        let mut sent = Vec::new();
        queue.run(|method, _| sent.push(method));
        assert_eq!(sent, Vec::<&str>::new());
        assert!(queue.flush(Duration::ZERO));
    }
}
