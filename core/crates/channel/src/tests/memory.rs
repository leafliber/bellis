//! 内存中的一对字节流，只供测试驱动握手与 RPC。

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Instant;

use crate::transport::{Transport, shut_down, timed_out};

#[derive(Default)]
struct Queue {
    bytes: VecDeque<u8>,
    eof: bool,
}

#[derive(Default)]
struct Pipe {
    queue: Mutex<Queue>,
    ready: Condvar,
}

impl Pipe {
    fn push(&self, bytes: &[u8]) {
        self.queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .bytes
            .extend(bytes);
        self.ready.notify_all();
    }

    fn close(&self) {
        self.queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .eof = true;
        self.ready.notify_all();
    }

    fn read(&self, buf: &mut [u8], deadline: Option<Instant>) -> io::Result<usize> {
        let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if !queue.bytes.is_empty() {
                let count = buf.len().min(queue.bytes.len());
                for (slot, byte) in buf.iter_mut().zip(queue.bytes.drain(..count)) {
                    *slot = byte;
                }
                return Ok(count);
            }
            if queue.eof {
                return Ok(0);
            }
            queue = match deadline {
                None => self
                    .ready
                    .wait(queue)
                    .unwrap_or_else(PoisonError::into_inner),
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(timed_out());
                    }
                    self.ready
                        .wait_timeout(queue, left)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
            };
        }
    }
}

pub(crate) struct MemoryTransport {
    inbound: Arc<Pipe>,
    outbound: Arc<Pipe>,
    shut: Mutex<bool>,
}

impl MemoryTransport {
    pub(crate) fn pair() -> (Self, Self) {
        let a = Arc::new(Pipe::default());
        let b = Arc::new(Pipe::default());
        (
            Self {
                inbound: Arc::clone(&a),
                outbound: Arc::clone(&b),
                shut: Mutex::new(false),
            },
            Self {
                inbound: b,
                outbound: a,
                shut: Mutex::new(false),
            },
        )
    }

    pub(crate) fn finish_writing(&self) {
        self.outbound.close();
    }

    pub(crate) fn drain(&self) -> Vec<u8> {
        let mut queue = self
            .inbound
            .queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        queue.bytes.drain(..).collect()
    }

    fn is_shut(&self) -> bool {
        *self.shut.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Transport for MemoryTransport {
    fn read(&self, buf: &mut [u8], deadline: Option<Instant>) -> io::Result<usize> {
        if self.is_shut() {
            return Err(shut_down());
        }
        self.inbound.read(buf, deadline)
    }

    fn write_all(&self, buf: &[u8], _deadline: Option<Instant>) -> io::Result<()> {
        if self.is_shut() {
            return Err(shut_down());
        }
        self.outbound.push(buf);
        Ok(())
    }

    fn shutdown(&self) {
        *self.shut.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.inbound.close();
        self.outbound.close();
    }
}
