use std::{env, process::ExitCode, time::Duration};

use bellis_channel::ChannelCredentials;
use bellis_watchdog::obs::{EmergencyPolicy, ObsEmergencyClient};
use windows::Win32::Security::Credentials::{CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW};
use windows::core::PCWSTR;

fn credential(target: &str) -> Result<String, String> {
    if target.is_empty() || target.contains('\0') {
        return Err("invalid OBS credential target".into());
    }
    let wide: Vec<_> = target.encode_utf16().chain([0]).collect();
    let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: wide is NUL terminated and ptr is writable for the call.
    let read = unsafe { CredReadW(PCWSTR(wide.as_ptr()), CRED_TYPE_GENERIC, None, &raw mut ptr) };
    if let Err(e) = read {
        return if e.code() == windows::core::HRESULT::from_win32(1168) {
            Ok(String::new())
        } else {
            Err("cannot read OBS credential".into())
        };
    }
    // SAFETY: Successful CredReadW returns a credential valid until CredFree.
    let cred = unsafe { &*ptr };
    let len = cred.CredentialBlobSize as usize;
    let result = if len == 0 {
        Ok(String::new())
    } else if !len.is_multiple_of(2) || cred.CredentialBlob.is_null() {
        Err("invalid OBS credential blob".into())
    } else {
        // SAFETY: The credential owns len readable bytes; byte slices need no alignment.
        let bytes = unsafe { std::slice::from_raw_parts(cred.CredentialBlob, len) };
        let units: Vec<_> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_le_bytes)
            .collect();
        String::from_utf16(&units)
            .map(|s| s.trim_end_matches('\0').to_owned())
            .map_err(|_| "invalid UTF-16 OBS credential".into())
    };
    // SAFETY: All reads are complete. Free the allocation exactly once.
    unsafe { CredFree(ptr.cast()) };
    result
}

fn extract_obs_password(raw: String) -> String {
    if raw.trim_start().starts_with('{')
        && let Ok(serde_json::Value::Object(data)) = serde_json::from_str(&raw)
        && data.get("url").is_none_or(serde_json::Value::is_string)
        && let Some(password) = data.get("password").and_then(serde_json::Value::as_str)
    {
        return password.to_owned();
    }
    raw
}

fn millis(value: &str) -> Result<Duration, String> {
    value
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .map(|n| Duration::from_millis(n.into()))
        .ok_or_else(|| "expected positive milliseconds".into())
}

fn start() -> Result<(), String> {
    let mut url = "ws://127.0.0.1:4455".to_owned();
    let mut target = "obs.bellis".to_owned();
    let mut policy = EmergencyPolicy {
        stage_source: "浏览器".into(),
        safe_scene: "Safe".into(),
        stop_stream: false,
    };
    let mut timeout = Duration::from_secs(1);
    let mut delay = Duration::from_millis(250);
    let mut once = false;
    let mut exit_on_stop = false;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .ok_or_else(|| format!("missing value for {flag}"))
        };
        match flag.as_str() {
            "--obs-url" => url = value()?,
            "--obs-cred" => target = value()?,
            "--stage-source" => policy.stage_source = value()?,
            "--safe-scene" => policy.safe_scene = value()?,
            "--stop-stream" => policy.stop_stream = true,
            "--heartbeat-timeout-ms" => timeout = millis(&value()?)?,
            "--reconnect-delay-ms" => delay = millis(&value()?)?,
            "--once" => once = true,
            "--exit-on-stop" => exit_on_stop = true,
            _ => return Err("unknown watchdog option".into()),
        }
    }
    let path = env::var("BELLIS_CHANNEL_PATH").map_err(|_| "missing channel path")?;
    let key = env::var("BELLIS_CHANNEL_KEY").map_err(|_| "missing channel key")?;
    let credentials = ChannelCredentials::decode(path, &key).map_err(|_| "invalid channel key")?;
    let password = match env::var("BELLIS_OBS_PASSWORD") {
        Ok(password) => password,
        Err(env::VarError::NotPresent) => extract_obs_password(credential(&target)?),
        Err(_) => return Err("invalid OBS password encoding".into()),
    };
    let obs = ObsEmergencyClient::new(url, password)?;
    bellis_watchdog::run(&credentials, timeout, delay, once, exit_on_stop, || {
        obs.run_emergency(&policy).unwrap_or(false)
    });
    Ok(())
}

fn main() -> ExitCode {
    match start() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("bellis-watchdog: {message}");
            ExitCode::FAILURE
        }
    }
}

#[test]
fn obs_credential_formats() {
    let legacy = r#"{"url":"ws://127.0.0.1:4455","password":"secret"}"#;
    assert_eq!(extract_obs_password(legacy.into()), "secret");
    assert_eq!(extract_obs_password(r#"{"password":""}"#.into()), "");
    assert_eq!(extract_obs_password("plain".into()), "plain");
    assert_eq!(extract_obs_password("{not-json".into()), "{not-json");
}
