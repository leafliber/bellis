//! 核连接（主控进程 ↔ 实时核）的 JSON-RPC 处理函数集合。

use std::sync::Arc;
use std::sync::mpsc::Sender;

use bellis_channel::{Handlers, RpcError, RpcErrorCode};
use serde_json::{Map, Value, json};

use super::{Ended, Media, Outbox};
use crate::audio::pipeline::audio_opener_for;
use crate::capture::TargetError;
use crate::capture::pipeline::opener_for;
use crate::clock;
use crate::control::{Configured, Control};
use crate::protocol::{
    ActionBlock, ActionSubmitResult, AudioRingAttachParams, Empty, FrameRingAttachParams,
    InputPolicy, ProducerHeartbeatParams, ProducerRevokeParams, ProducerRevokeResult,
    WindowTargetParams, core_methods, error_code,
};
use crate::ring::{AudioRingWriter, FrameRingWriter};

fn parse<T: serde::de::DeserializeOwned>(params: &Map<String, Value>) -> Result<T, String> {
    serde_json::from_value(Value::Object(params.clone())).map_err(|error| error.to_string())
}

fn invalid_params(method: &str, error: &str) -> RpcError {
    RpcError::new(
        RpcErrorCode::INVALID_PARAMS,
        format!("invalid params for {method}: {error}"),
    )
}

fn empty() -> Value {
    serde_json::to_value(Empty {}).unwrap_or_else(|_| json!({}))
}

fn capture_stopped() -> RpcError {
    RpcError::new(
        RpcErrorCode::INTERNAL_ERROR,
        "the capture thread has stopped",
    )
}

fn audio_stopped() -> RpcError {
    RpcError::new(RpcErrorCode::INTERNAL_ERROR, "the audio thread has stopped")
}

/// 组装核连接的全部请求与通知处理函数。
pub(crate) fn build_handlers(
    control: &Arc<Control>,
    outbox: &Arc<Outbox>,
    media: &Arc<Media>,
    ended: Sender<Ended>,
) -> Handlers {
    let heartbeat = {
        let (control, outbox) = (Arc::clone(control), Arc::clone(outbox));
        move |params: &Map<String, Value>| {
            let heartbeat: ProducerHeartbeatParams = match parse(params) {
                Ok(heartbeat) => heartbeat,
                Err(error) => {
                    log!("ignored {}: {error}", core_methods::PRODUCER_HEARTBEAT);
                    return;
                }
            };
            match control.heartbeat(&heartbeat, clock::now_ns()) {
                Ok(notices) => outbox.send(notices),
                Err(rejection) => log!(
                    "ignored {} from {:?} seq {}: {rejection:?}",
                    core_methods::PRODUCER_HEARTBEAT,
                    heartbeat.producer,
                    heartbeat.seq
                ),
            }
        }
    };
    let revoke = {
        let (control, outbox) = (Arc::clone(control), Arc::clone(outbox));
        move |params: &Map<String, Value>| {
            let revoke: ProducerRevokeParams = parse(params)
                .map_err(|error| invalid_params(core_methods::PRODUCER_REVOKE, &error))?;
            let (release_id, notices) = control.revoke(revoke.generation);
            outbox.send(notices);
            Ok(json!(ProducerRevokeResult { release_id }))
        }
    };
    let shutdown = {
        let (control, outbox) = (Arc::clone(control), Arc::clone(outbox));
        move |params: &Map<String, Value>| {
            let _: Empty =
                parse(params).map_err(|error| invalid_params(core_methods::SHUTDOWN, &error))?;
            outbox.send(control.shutdown());
            Ok(empty())
        }
    };
    let after_shutdown = move || {
        let _ = ended.send(Ended::Stopped);
    };

    Handlers::new()
        .notification(core_methods::PRODUCER_HEARTBEAT, heartbeat)
        .request(core_methods::PRODUCER_REVOKE, revoke)
        .request_then(core_methods::SHUTDOWN, shutdown, after_shutdown)
        .request(core_methods::ACTION_SUBMIT, submit_handler(control, outbox))
        .request(core_methods::FRAME_RING_ATTACH, frame_attach_handler(media))
        .request(
            core_methods::CAPTURE_SET_TARGET,
            capture_target_handler(media),
        )
        .request(core_methods::AUDIO_RING_ATTACH, audio_attach_handler(media))
        .request(core_methods::AUDIO_SET_TARGET, audio_target_handler(media))
        .request(core_methods::INPUT_CONFIGURE, configure_handler(control))
}

fn frame_attach_handler(
    media: &Arc<Media>,
) -> impl Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync + 'static {
    let media = Arc::clone(media);
    move |params| {
        let params: FrameRingAttachParams = parse(params)
            .map_err(|error| invalid_params(core_methods::FRAME_RING_ATTACH, &error))?;
        let writer = FrameRingWriter::attach(&params).map_err(|error| {
            log!(
                "{} {:?} refused: {error}",
                core_methods::FRAME_RING_ATTACH,
                params.name
            );
            RpcError::new(error_code::FRAME_RING_MISMATCH, error.to_string())
        })?;
        log!(
            "attached frame ring {:?}; frame numbers continue after {}",
            params.name,
            writer.last_frame_number()
        );
        media
            .capture
            .attach(writer)
            .map_err(|_| capture_stopped())?;
        Ok(empty())
    }
}

fn capture_target_handler(
    media: &Arc<Media>,
) -> impl Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync + 'static {
    let media = Arc::clone(media);
    move |params| {
        let params: WindowTargetParams = parse(params)
            .map_err(|error| invalid_params(core_methods::CAPTURE_SET_TARGET, &error))?;
        let opener = opener_for(params).map_err(|error| {
            log!("{} refused: {error}", core_methods::CAPTURE_SET_TARGET);
            let code = match &error {
                TargetError::Invalid(_) => RpcErrorCode::INVALID_PARAMS,
                TargetError::Unsupported(_) => error_code::CAPTURE_UNSUPPORTED,
            };
            RpcError::new(code, error.to_string())
        })?;
        log!("capture target: {opener}");
        media
            .capture
            .set_target(opener)
            .map_err(|_| capture_stopped())?;
        Ok(empty())
    }
}

fn audio_attach_handler(
    media: &Arc<Media>,
) -> impl Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync + 'static {
    let media = Arc::clone(media);
    move |params| {
        let params: AudioRingAttachParams = parse(params)
            .map_err(|error| invalid_params(core_methods::AUDIO_RING_ATTACH, &error))?;
        let writer = AudioRingWriter::attach(&params).map_err(|error| {
            log!(
                "{} {:?} refused: {error}",
                core_methods::AUDIO_RING_ATTACH,
                params.name
            );
            RpcError::new(error_code::AUDIO_RING_MISMATCH, error.to_string())
        })?;
        log!(
            "attached audio ring {:?} ({}); block numbers continue after {}",
            params.name,
            writer.format(),
            writer.last_block_number()
        );
        media.audio.attach(writer).map_err(|_| audio_stopped())?;
        Ok(empty())
    }
}

fn audio_target_handler(
    media: &Arc<Media>,
) -> impl Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync + 'static {
    let media = Arc::clone(media);
    move |params| {
        let params: WindowTargetParams = parse(params)
            .map_err(|error| invalid_params(core_methods::AUDIO_SET_TARGET, &error))?;
        let opener = audio_opener_for(params).map_err(|error| {
            log!("{} refused: {error}", core_methods::AUDIO_SET_TARGET);
            RpcError::new(RpcErrorCode::INVALID_PARAMS, error.to_string())
        })?;
        log!("audio target: {opener}");
        media
            .audio
            .set_target(opener)
            .map_err(|_| audio_stopped())?;
        Ok(empty())
    }
}

fn configure_handler(
    control: &Arc<Control>,
) -> impl Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync + 'static {
    let control = Arc::clone(control);
    move |params| {
        let policy: InputPolicy =
            parse(params).map_err(|error| invalid_params(core_methods::INPUT_CONFIGURE, &error))?;
        match control.configure(&policy) {
            Ok(Configured::Accepted) => {
                log!("input policy configured");
                Ok(empty())
            }
            Ok(Configured::Conflict) => Err(RpcError::new(
                error_code::INPUT_POLICY_CONFLICT,
                "the input policy is already set for this instance",
            )),
            Err(message) => Err(invalid_params(core_methods::INPUT_CONFIGURE, &message)),
        }
    }
}

fn submit_handler(
    control: &Arc<Control>,
    outbox: &Arc<Outbox>,
) -> impl Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync + 'static {
    let (control, outbox) = (Arc::clone(control), Arc::clone(outbox));
    move |params| {
        let block: ActionBlock =
            parse(params).map_err(|error| invalid_params(core_methods::ACTION_SUBMIT, &error))?;
        let (producer, seq) = (block.producer.clone(), block.seq);
        let (result, notices) = control.submit(block, clock::now_ns());
        outbox.post(notices);
        if let ActionSubmitResult::Rejected(rejected) = &result {
            log!(
                "{} from {producer:?} seq {seq} rejected: {:?} ({})",
                core_methods::ACTION_SUBMIT,
                rejected.reason,
                rejected.message
            );
        }
        serde_json::to_value(result).map_err(|error| {
            RpcError::new(
                RpcErrorCode::INTERNAL_ERROR,
                format!("cannot encode: {error}"),
            )
        })
    }
}
