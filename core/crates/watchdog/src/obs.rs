//! Synchronous loopback obs-websocket v5 emergency connection.

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tungstenite::client::{IntoClientRequest, client_with_config};
use tungstenite::{Message, WebSocket};

const TIMEOUT: Duration = Duration::from_secs(2);
const BATCH_ID: &str = "watchdog-emergency";

pub struct EmergencyPolicy {
    pub stage_source: String,
    pub safe_scene: String,
    pub stop_stream: bool,
}

pub struct ObsEmergencyClient {
    url: String,
    addr: SocketAddr,
    password: String,
}

// SHA256 always yields 32 bytes, hence exactly one padding character.
fn digest64(first: &str, second: &str) -> String {
    let digest = Sha256::new()
        .chain_update(first)
        .chain_update(second)
        .finalize();
    bellis_channel::encode_session_key(&digest.into())
        .replace('-', "+")
        .replace('_', "/")
        + "="
}

fn auth(password: &str, salt: &str, challenge: &str) -> String {
    digest64(&digest64(password, salt), challenge)
}

fn requests(policy: &EmergencyPolicy) -> Vec<Value> {
    let mut items = vec![
        json!({"requestType":"SetInputMute","requestData":{"inputName":policy.stage_source,"inputMuted":true}}),
        json!({"requestType":"SetCurrentProgramScene","requestData":{"sceneName":policy.safe_scene}}),
    ];
    if policy.stop_stream {
        items.push(json!({"requestType":"StopStream"}));
    }
    items
}

fn batch_ok(data: &Value, sent: &[Value]) -> Result<bool, String> {
    let results = data["results"]
        .as_array()
        .ok_or("missing OBS batch results")?;
    if data["requestId"] != BATCH_ID || results.len() != sent.len() {
        return Err("unexpected OBS batch response".into());
    }
    Ok(results.iter().zip(sent).all(|(result, request)| {
        let status = &result["requestStatus"];
        result["requestType"] == request["requestType"]
            && (status["result"] == true
                || (request["requestType"] == "StopStream"
                    && status["result"] == false
                    && status["code"] == 501))
    }))
}

fn receive(ws: &mut WebSocket<TcpStream>, op: u8) -> Result<Value, String> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("OBS read timed out".into());
        }
        ws.get_ref()
            .set_read_timeout(Some(remaining))
            .map_err(|e| e.to_string())?;
        match ws.read().map_err(|e| e.to_string())? {
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Text(text) => {
                let mut frame: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if frame["op"] == 5 {
                    continue;
                }
                if frame["op"] == op && frame["d"].is_object() {
                    return Ok(frame["d"].take());
                }
            }
            _ => {}
        }
        return Err(format!("expected OBS opcode {op}"));
    }
}

impl ObsEmergencyClient {
    /// # Errors
    /// Requires an explicit port on an IPv4 loopback WebSocket URL.
    pub fn new(url: String, password: String) -> Result<Self, String> {
        let authority = url
            .strip_prefix("ws://")
            .ok_or("expected ws:// loopback URL")?;
        let authority = authority.strip_suffix('/').unwrap_or(authority);
        let (host, port) = authority.split_once(':').ok_or("missing OBS port")?;
        if !matches!(host, "localhost" | "127.0.0.1") || !port.bytes().all(|b| b.is_ascii_digit()) {
            return Err("invalid loopback OBS URL".into());
        }
        let port = port
            .parse::<u16>()
            .ok()
            .filter(|p| *p != 0)
            .ok_or("invalid OBS port")?;
        Ok(Self {
            url,
            password,
            addr: (Ipv4Addr::LOCALHOST, port).into(),
        })
    }

    /// # Errors
    /// Returns transport, authentication and protocol errors without retrying a batch.
    pub fn run_emergency(&self, policy: &EmergencyPolicy) -> Result<bool, String> {
        let stream = TcpStream::connect_timeout(&self.addr, TIMEOUT).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(TIMEOUT))
            .and_then(|()| stream.set_write_timeout(Some(TIMEOUT)))
            .map_err(|e| e.to_string())?;
        let mut request = self
            .url
            .as_str()
            .into_client_request()
            .map_err(|e| e.to_string())?;
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            tungstenite::http::HeaderValue::from_static("obswebsocket.json"),
        );
        let (mut ws, _) = client_with_config(request, stream, None)
            .map_err(|_| "OBS WebSocket handshake failed")?;
        let hello = receive(&mut ws, 0)?;
        let mut identify = json!({"rpcVersion":1,"eventSubscriptions":0});
        if let Some(a) = hello.get("authentication").filter(|v| v.is_object()) {
            identify["authentication"] = auth(
                &self.password,
                a["salt"].as_str().ok_or("missing salt")?,
                a["challenge"].as_str().ok_or("missing challenge")?,
            )
            .into();
        }
        ws.send(Message::text(json!({"op":1,"d":identify}).to_string()))
            .map_err(|e| e.to_string())?;
        if receive(&mut ws, 2)?["negotiatedRpcVersion"] != 1 {
            return Err("unsupported OBS RPC version".into());
        }
        let sent = requests(policy);
        let batch = json!({"op":8,"d":{"requestId":BATCH_ID,"haltOnFailure":false,"executionType":0,"requests":sent}});
        ws.send(Message::text(batch.to_string()))
            .map_err(|e| e.to_string())?;
        let reply = receive(&mut ws, 9)?;
        let _ = ws.close(None);
        batch_ok(&reply, &sent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_vector_and_batch_results() {
        assert_eq!(
            auth("password", "salt", "challenge"),
            "zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA="
        );
        let items = requests(&EmergencyPolicy {
            stage_source: "Stage".into(),
            safe_scene: "Safe".into(),
            stop_stream: true,
        });
        let mut reply = json!({"requestId":BATCH_ID,"results":[
            {"requestType":"SetInputMute","requestStatus":{"result":true,"code":100}},
            {"requestType":"SetCurrentProgramScene","requestStatus":{"result":true,"code":100}},
            {"requestType":"StopStream","requestStatus":{"result":false,"code":501}}
        ]});
        assert!(batch_ok(&reply, &items).unwrap());
        reply["results"][0]["requestStatus"] = json!({"result":false,"code":501});
        assert!(!batch_ok(&reply, &items).unwrap());
        assert!(batch_ok(&reply, &items[..2]).is_err());
    }
}
