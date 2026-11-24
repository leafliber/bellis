//! 实时核通知出口：向核连接发通知，并把每条 `input.released` 与 `health` 镜像给统一许可控制连接。

use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use bellis_channel::RpcPeer;
use serde_json::{Map, Value};

use super::queue::SendQueue;
use crate::control::{Notice, Notices};
use crate::protocol::{HealthParams, InputReleasedParams, core_methods, permit_methods};

/// 核连接与统一许可控制连接的通知出口。
pub(crate) struct Outbox {
    peer: OnceLock<Weak<RpcPeer>>,
    queue: SendQueue,
    permit: Option<Arc<SendQueue>>,
}

fn to_params(method: &str, params: &impl serde::Serialize) -> Option<Map<String, Value>> {
    if let Ok(Value::Object(params)) = serde_json::to_value(params) {
        Some(params)
    } else {
        log!("{method} not sent: params are not an object");
        None
    }
}

impl Outbox {
    pub(crate) fn new(permit: Option<Arc<SendQueue>>) -> Self {
        Self {
            peer: OnceLock::new(),
            queue: SendQueue::default(),
            permit,
        }
    }

    pub(crate) fn attach(&self, peer: &Arc<RpcPeer>) {
        let _ = self.peer.set(Arc::downgrade(peer));
    }

    fn write(&self, method: &str, params: &Map<String, Value>) {
        let Some(peer) = self.peer.wait().upgrade() else {
            return;
        };
        if let Err(error) = peer.notify(method, Some(params)) {
            log!("{method} not sent: {error}");
        }
    }

    pub(crate) fn notify_health(&self, params: &HealthParams) {
        if let Some(map) = to_params(core_methods::HEALTH, params) {
            if let Some(permit) = &self.permit {
                permit.push(permit_methods::HEALTH, map.clone());
            }
            self.write(core_methods::HEALTH, &map);
        }
    }

    pub(crate) fn mirror_released(&self, released: &InputReleasedParams) {
        if let Some(permit) = &self.permit
            && let Some(params) = to_params(permit_methods::INPUT_RELEASED, released)
        {
            permit.push(permit_methods::INPUT_RELEASED, params);
        }
    }

    pub(crate) fn log_and_mirror(&self, notices: &Notices) {
        for notice in &notices.0 {
            if let Notice::Released(released) = notice {
                log_released(released);
                self.mirror_released(released);
            }
        }
    }

    fn each(&self, notices: Notices, mut deliver: impl FnMut(&'static str, Map<String, Value>)) {
        for notice in notices.0 {
            let (method, params) = match &notice {
                Notice::Released(released) => {
                    log_released(released);
                    self.mirror_released(released);
                    (
                        core_methods::INPUT_RELEASED,
                        to_params(core_methods::INPUT_RELEASED, released),
                    )
                }
                Notice::Receipt(receipt) => (
                    core_methods::ACTION_RECEIPT,
                    to_params(core_methods::ACTION_RECEIPT, receipt),
                ),
            };
            if let Some(params) = params {
                deliver(method, params);
            }
        }
    }

    pub(crate) fn send(&self, notices: Notices) {
        self.each(notices, |method, params| self.write(method, &params));
    }

    pub(crate) fn post(&self, notices: Notices) {
        self.each(notices, |method, params| self.queue.push(method, params));
    }

    pub(crate) fn run_sender(&self) {
        self.queue.run(|method, params| self.write(method, params));
    }

    pub(crate) fn close(&self, timeout: Duration) {
        if !self.queue.flush(timeout) {
            log!("notifications not flushed within {}ms", timeout.as_millis());
        }
        self.queue.abandon();
    }
}

pub(crate) fn log_released(released: &InputReleasedParams) {
    log!(
        "input release #{}: {:?} (producer {:?}, verification {:?}, residual {})",
        released.release_id,
        released.reason,
        released.producer,
        released.verification,
        released.residual_items.len()
    );
}
