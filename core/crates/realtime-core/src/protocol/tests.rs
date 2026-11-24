//! 跨语言防漂移契约夹具测试：严格反序列化 + 再序列化往返逐字段一致。

use std::fs;
use std::path::PathBuf;

use bellis_channel::{RpcKind, classify};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{
    ActionBlock, ActionReceiptParams, ActionSubmitResult, AudioRingAttachParams, CoreHelloParams,
    CoreHelloResult, Empty, FrameRingAttachParams, HealthParams, InputPolicy, InputReleasedParams,
    InputStopParams, InputStopResult, LeaseRenewParams, LeaseRevokeParams, PROTOCOL_VERSION,
    ProducerHeartbeatParams, ProducerRevokeParams, ProducerRevokeResult, WindowTargetParams,
    core_methods, error_code, permit_methods,
};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("tests/fixtures/realtime_core")
        .join(name)
}

fn load_fixture(name: &str) -> Value {
    let text = fs::read_to_string(fixture_path(name))
        .unwrap_or_else(|error| panic!("cannot read fixture {name}: {error}"));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse fixture {name}: {error}"))
}

fn assert_roundtrip<T: DeserializeOwned + Serialize>(name: &str, value: &Value) {
    let decoded: T = serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("{name}: failed to deserialize: {error}"));
    let encoded = serde_json::to_value(&decoded)
        .unwrap_or_else(|error| panic!("{name}: failed to re-serialize: {error}"));
    assert_eq!(&encoded, value, "{name}: JSON roundtrip mismatch");
}

fn expected_kind(kind: &str) -> RpcKind {
    match kind {
        "request" => RpcKind::Request,
        "notification" => RpcKind::Notification,
        "success" => RpcKind::Success,
        "failure" => RpcKind::Failure,
        other => panic!("unexpected fixture kind {other}"),
    }
}

#[test]
fn permit_rpc_fixture_roundtrips_exactly() {
    let doc = load_fixture("permit_rpc.json");
    assert_eq!(doc["protocol_version"], PROTOCOL_VERSION);
    assert_eq!(
        doc["error_codes"]["LEASE_REFUSED"],
        error_code::LEASE_REFUSED
    );

    let cases = doc["cases"].as_array().expect("cases array");
    let mut seen_methods = std::collections::HashSet::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let kind = case["kind"].as_str().unwrap();
        let method = case["method"].as_str().unwrap();
        let envelope = &case["envelope"];
        assert_eq!(classify(envelope), expected_kind(kind), "{name}");
        seen_methods.insert(method.to_owned());

        match (kind, method) {
            ("request", permit_methods::LEASE_RENEW) => {
                assert_roundtrip::<LeaseRenewParams>(name, &envelope["params"]);
            }
            ("success", permit_methods::LEASE_RENEW | permit_methods::LEASE_REVOKE) => {
                assert_roundtrip::<Empty>(name, &envelope["result"]);
            }
            ("failure", permit_methods::LEASE_RENEW) => {
                assert_eq!(envelope["error"]["code"], error_code::LEASE_REFUSED);
            }
            ("request", permit_methods::LEASE_REVOKE) => {
                assert_roundtrip::<LeaseRevokeParams>(name, &envelope["params"]);
            }
            ("request", permit_methods::INPUT_STOP) => {
                assert_roundtrip::<InputStopParams>(name, &envelope["params"]);
            }
            ("success", permit_methods::INPUT_STOP) => {
                assert_roundtrip::<InputStopResult>(name, &envelope["result"]);
            }
            ("notification", permit_methods::INPUT_RELEASED) => {
                assert_roundtrip::<InputReleasedParams>(name, &envelope["params"]);
            }
            ("notification", permit_methods::HEALTH) => {
                assert_roundtrip::<HealthParams>(name, &envelope["params"]);
            }
            other => panic!("unhandled permit fixture case {name}: {other:?}"),
        }
    }

    for required in [
        permit_methods::LEASE_RENEW,
        permit_methods::LEASE_REVOKE,
        permit_methods::INPUT_STOP,
        permit_methods::INPUT_RELEASED,
        permit_methods::HEALTH,
    ] {
        assert!(
            seen_methods.contains(required),
            "missing fixture for {required}"
        );
    }
}

#[test]
#[allow(clippy::too_many_lines, reason = "核连接全量方法夹具逐项往返核对")]
fn core_rpc_fixture_roundtrips_exactly() {
    let doc = load_fixture("core_rpc.json");
    assert_eq!(doc["protocol_version"], PROTOCOL_VERSION);
    assert_eq!(
        doc["error_codes"]["PROTOCOL_VERSION_MISMATCH"],
        error_code::PROTOCOL_VERSION_MISMATCH
    );
    assert_eq!(
        doc["error_codes"]["FRAME_RING_MISMATCH"],
        error_code::FRAME_RING_MISMATCH
    );
    assert_eq!(
        doc["error_codes"]["CAPTURE_UNSUPPORTED"],
        error_code::CAPTURE_UNSUPPORTED
    );
    assert_eq!(
        doc["error_codes"]["AUDIO_RING_MISMATCH"],
        error_code::AUDIO_RING_MISMATCH
    );
    assert_eq!(
        doc["error_codes"]["INPUT_POLICY_CONFLICT"],
        error_code::INPUT_POLICY_CONFLICT
    );

    let cases = doc["cases"].as_array().expect("cases array");
    let mut seen_methods = std::collections::HashSet::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let kind = case["kind"].as_str().unwrap();
        let method = case["method"].as_str().unwrap();
        let envelope = &case["envelope"];
        assert_eq!(classify(envelope), expected_kind(kind), "{name}");
        seen_methods.insert(method.to_owned());

        match (kind, method) {
            ("request", core_methods::CORE_HELLO) => {
                assert_roundtrip::<CoreHelloParams>(name, &envelope["params"]);
            }
            ("success", core_methods::CORE_HELLO) => {
                assert_roundtrip::<CoreHelloResult>(name, &envelope["result"]);
            }
            ("failure", core_methods::CORE_HELLO) => {
                assert_eq!(
                    envelope["error"]["code"],
                    error_code::PROTOCOL_VERSION_MISMATCH
                );
            }
            ("request", core_methods::FRAME_RING_ATTACH) => {
                assert_roundtrip::<FrameRingAttachParams>(name, &envelope["params"]);
            }
            ("request", core_methods::CAPTURE_SET_TARGET | core_methods::AUDIO_SET_TARGET) => {
                assert_roundtrip::<WindowTargetParams>(name, &envelope["params"]);
            }
            ("request", core_methods::AUDIO_RING_ATTACH) => {
                assert_roundtrip::<AudioRingAttachParams>(name, &envelope["params"]);
            }
            ("request", core_methods::INPUT_CONFIGURE) => {
                assert_roundtrip::<InputPolicy>(name, &envelope["params"]);
            }
            ("failure", core_methods::INPUT_CONFIGURE) => {
                assert_eq!(envelope["error"]["code"], error_code::INPUT_POLICY_CONFLICT);
            }
            ("notification", core_methods::PRODUCER_HEARTBEAT) => {
                assert_roundtrip::<ProducerHeartbeatParams>(name, &envelope["params"]);
            }
            ("request", core_methods::PRODUCER_REVOKE) => {
                assert_roundtrip::<ProducerRevokeParams>(name, &envelope["params"]);
            }
            ("success", core_methods::PRODUCER_REVOKE) => {
                assert_roundtrip::<ProducerRevokeResult>(name, &envelope["result"]);
            }
            ("request", core_methods::ACTION_SUBMIT) => {
                assert_roundtrip::<ActionBlock>(name, &envelope["params"]);
            }
            ("success", core_methods::ACTION_SUBMIT) => {
                assert_roundtrip::<ActionSubmitResult>(name, &envelope["result"]);
            }
            ("notification", core_methods::ACTION_RECEIPT) => {
                assert_roundtrip::<ActionReceiptParams>(name, &envelope["params"]);
            }
            ("notification", core_methods::INPUT_RELEASED) => {
                assert_roundtrip::<InputReleasedParams>(name, &envelope["params"]);
            }
            ("notification", core_methods::HEALTH) => {
                assert_roundtrip::<HealthParams>(name, &envelope["params"]);
            }
            ("request", core_methods::SHUTDOWN) => {
                assert_roundtrip::<Empty>(name, &envelope["params"]);
            }
            (
                "success",
                core_methods::FRAME_RING_ATTACH
                | core_methods::CAPTURE_SET_TARGET
                | core_methods::AUDIO_RING_ATTACH
                | core_methods::AUDIO_SET_TARGET
                | core_methods::INPUT_CONFIGURE
                | core_methods::SHUTDOWN,
            ) => {
                assert_roundtrip::<Empty>(name, &envelope["result"]);
            }
            other => panic!("unhandled core fixture case {name}: {other:?}"),
        }
    }

    for required in [
        core_methods::CORE_HELLO,
        core_methods::FRAME_RING_ATTACH,
        core_methods::CAPTURE_SET_TARGET,
        core_methods::AUDIO_RING_ATTACH,
        core_methods::AUDIO_SET_TARGET,
        core_methods::INPUT_CONFIGURE,
        core_methods::PRODUCER_HEARTBEAT,
        core_methods::PRODUCER_REVOKE,
        core_methods::ACTION_SUBMIT,
        core_methods::ACTION_RECEIPT,
        core_methods::INPUT_RELEASED,
        core_methods::HEALTH,
        core_methods::SHUTDOWN,
    ] {
        assert!(
            seen_methods.contains(required),
            "missing fixture for {required}"
        );
    }
}

#[test]
fn rejects_unknown_fields_on_protocol_structs() {
    let extra_lease = serde_json::json!({
        "token": 1,
        "expires_ns": 100,
        "unexpected": true
    });
    assert!(serde_json::from_value::<LeaseRenewParams>(extra_lease).is_err());

    let extra_stop = serde_json::json!({
        "through_token": null,
        "extra": 1
    });
    assert!(serde_json::from_value::<InputStopParams>(extra_stop).is_err());
}
