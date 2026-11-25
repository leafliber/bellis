//! Standalone Host heartbeat monitor.
pub mod obs;

use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bellis_channel::{ChannelCredentials, ConnectionOptions, Message, RpcKind, classify, connect};
use serde::Serialize;
use serde_json::json;

#[derive(Serialize)]
pub struct WatchdogActed {
    reason: &'static str,
    ok: bool,
    acted_at_ms: u128,
}

struct State {
    last_heartbeat: Instant,
    acted: bool,
    stopping: bool,
    closed: bool,
}

struct Session {
    state: Mutex<State>,
    changed: Condvar,
}

impl Session {
    fn new(acted: bool) -> Self {
        Self {
            state: Mutex::new(State {
                last_heartbeat: Instant::now(),
                acted,
                stopping: false,
                closed: false,
            }),
            changed: Condvar::new(),
        }
    }

    fn update(&self, method: Option<&str>) {
        let mut state = self.state.lock().unwrap();
        match method {
            None => state.closed = true,
            Some("host.stopping") => state.stopping = true,
            Some("host.heartbeat") if !state.stopping => {
                state.last_heartbeat = Instant::now();
                state.acted = false;
            }
            _ => return,
        }
        self.changed.notify_one();
    }

    fn monitor(
        &self,
        timeout: Duration,
        mut emergency: impl FnMut() -> bool,
        mut report: impl FnMut(WatchdogActed),
    ) -> (bool, bool) {
        let mut state = self.state.lock().unwrap();
        loop {
            if !state.stopping && !state.acted {
                let remaining = timeout.saturating_sub(state.last_heartbeat.elapsed());
                let reason = if state.closed {
                    "connection_lost"
                } else if remaining.is_zero() {
                    "heartbeat_lost"
                } else {
                    state = self.changed.wait_timeout(state, remaining).unwrap().0;
                    continue;
                };
                state.acted = true;
                drop(state);
                report(WatchdogActed {
                    reason,
                    ok: emergency(),
                    acted_at_ms: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis(),
                });
                state = self.state.lock().unwrap();
            } else if state.closed {
                return (state.stopping, state.acted);
            } else {
                state = self.changed.wait(state).unwrap();
            }
        }
    }
}

/// Monitor successive authenticated sessions, retaining undelivered reports across disconnects.
pub fn run(
    credentials: &ChannelCredentials,
    timeout: Duration,
    delay: Duration,
    once: bool,
    exit_on_stop: bool,
    mut emergency: impl FnMut() -> bool,
) {
    let mut acted = false;
    let mut pending = std::collections::VecDeque::new();
    loop {
        if let Ok(conn) = connect(
            &credentials.path,
            "watchdog",
            &credentials.key,
            &ConnectionOptions::default(),
        ) {
            let deliver = |report: &WatchdogActed| {
                let frame = json!({"jsonrpc":"2.0","method":"watchdog.acted","params":report});
                conn.send_with_timeout(&frame, Duration::from_secs(2))
                    .is_ok()
            };
            while pending.front().is_some_and(deliver) {
                pending.pop_front();
            }
            let session = Session::new(acted);
            let (planned, latched) = thread::scope(|scope| {
                scope.spawn(|| {
                    while let Ok(message) = conn.recv(None) {
                        if let Message::Json(frame) = message
                            && classify(&frame) == RpcKind::Notification
                            && let Some(method) = frame["method"].as_str()
                        {
                            session.update(Some(method));
                            if method == "host.stopping" {
                                let ack = json!({"jsonrpc":"2.0","method":"watchdog.stopping"});
                                let _ = conn.send_with_timeout(&ack, Duration::from_secs(2));
                            }
                        }
                    }
                    session.update(None);
                });
                session.monitor(timeout, &mut emergency, |report| {
                    if !deliver(&report) {
                        pending.push_back(report);
                    }
                })
            });
            if once || (exit_on_stop && planned) {
                return;
            }
            acted = if planned { false } else { latched };
        }
        thread::sleep(delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_reports_once_until_new_heartbeat() {
        let session = Session::new(false);
        let mut calls = 0;
        let mut reports = 0;
        let result = session.monitor(
            Duration::from_millis(1),
            || {
                calls += 1;
                true
            },
            |report| {
                assert_eq!(report.reason, "heartbeat_lost");
                assert!(report.ok && report.acted_at_ms > 0);
                reports += 1;
                if reports == 1 {
                    session.update(Some("host.heartbeat"));
                } else {
                    session.update(None);
                }
            },
        );
        assert_eq!((calls, reports, result), (2, 2, (false, true)));
    }

    #[test]
    fn disconnect_acts_unless_planned() {
        for planned in [true, false] {
            let session = Session::new(false);
            if planned {
                session.update(Some("host.stopping"));
                session.update(Some("host.heartbeat"));
            }
            session.update(None);
            let mut calls = 0;
            let result = session.monitor(
                Duration::from_secs(1),
                || {
                    calls += 1;
                    false
                },
                |r| {
                    assert_eq!(r.reason, "connection_lost");
                    assert!(!r.ok);
                },
            );
            assert_eq!(result, (planned, !planned));
            assert_eq!(calls, i32::from(!planned));
        }
    }
}
