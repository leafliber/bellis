//! Windows 凭据管理器中的跨进程 `SessionInfo` 读取与严格校验。

use std::io;

use bellis_channel::ChannelCredentials;
use serde::Deserialize;

/// 已通过格式校验的许可会话信息。
#[derive(PartialEq, Eq)]
pub(crate) struct Session {
    pub(crate) id: String,
    pub(crate) credentials: ChannelCredentials,
    launcher_pid: u64,
    started_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionInfo {
    v: u8,
    session_id: String,
    channel_path: String,
    channel_key: String,
    launcher_pid: u64,
    started_at: String,
}

impl Session {
    pub(crate) fn decode(text: &str) -> Option<Self> {
        if !text.trim_start().starts_with('{') {
            return None;
        }
        let info: SessionInfo = serde_json::from_str(text).ok()?;
        if info.v != 1
            || !is_session_id(&info.session_id)
            || !(1..=260).contains(&info.channel_path.chars().count())
            || info.channel_path.contains('\0')
            || info.launcher_pid == 0
        {
            return None;
        }
        #[cfg(windows)]
        if !info.channel_path.starts_with(r"\\.\pipe\") {
            return None;
        }
        date_time(info.started_at.as_bytes())?;
        Some(Self {
            id: info.session_id,
            credentials: ChannelCredentials::decode(info.channel_path, &info.channel_key).ok()?,
            launcher_pid: info.launcher_pid,
            started_at: info.started_at,
        })
    }
}

/// 读取并校验指定 Windows 通用凭据目标名里的 `SessionInfo` JSON。
pub(crate) fn read_session_info(target: &str) -> io::Result<Session> {
    let text = read_credential(target)?;
    Session::decode(&text)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid SessionInfo credential"))
}

/// 校验会话号格式（1–16 位小写 ASCII 字母或数字）。
#[must_use]
pub(crate) fn is_session_id(value: &str) -> bool {
    (1..=16).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn date_time(text: &[u8]) -> Option<()> {
    let ([y1, y2, y3, y4, b'-', m1, m2, b'-', d1, d2], time) = text.split_at_checked(10)? else {
        return None;
    };
    let year = number(&[*y1, *y2, *y3, *y4])?;
    let month = usize::try_from(number(&[*m1, *m2])?).ok()?;
    let day = number(&[*d1, *d2])?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        0,
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=*days.get(month)?).contains(&day) {
        return None;
    }

    let [b'T' | b't', h1, h2, b':', n1, n2, b':', s1, s2, suffix @ ..] = time else {
        return None;
    };
    let hour = number(&[*h1, *h2])?;
    let minute = number(&[*n1, *n2])?;
    let second = number(&[*s1, *s2])?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let zone_start = suffix
        .iter()
        .position(|byte| matches!(byte, b'Z' | b'z' | b'+' | b'-'))?;
    if zone_start > 0 {
        let [b'.', fraction @ ..] = &suffix[..zone_start] else {
            return None;
        };
        if fraction.is_empty() || !fraction.iter().all(u8::is_ascii_digit) {
            return None;
        }
    }
    let offset = match &suffix[zone_start..] {
        [b'Z' | b'z'] => 0,
        [sign @ (b'+' | b'-'), a, b, b':', c, d] => {
            let hours = number(&[*a, *b])?;
            let minutes = number(&[*c, *d])?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            (if *sign == b'-' { -1 } else { 1 }) * (hours * 60 + minutes)
        }
        _ => return None,
    };
    (second < 60 || (hour * 60 + minute - offset).rem_euclid(1440) == 1439).then_some(())
}

fn number(digits: &[u8]) -> Option<i32> {
    digits.iter().try_fold(0, |total, byte| {
        byte.is_ascii_digit()
            .then(|| total * 10 + i32::from(byte - b'0'))
    })
}

#[cfg(windows)]
fn read_credential(target: &str) -> io::Result<String> {
    use windows::Win32::Security::Credentials::{
        CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
    };
    use windows::core::PCWSTR;

    if target.is_empty() || target.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid Windows Credential Manager target name",
        ));
    }
    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: `wide` 是 NUL 结尾的 UTF-16 切片；成功时 `CredReadW` 返回须由 `CredFree` 释放的指针。
    unsafe {
        CredReadW(
            PCWSTR(wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &raw mut pointer,
        )
    }
    .map_err(|error| io::Error::from_raw_os_error(error.code().0 & 0xffff))?;
    if pointer.is_null() {
        return Err(io::Error::other("CredReadW returned no credential"));
    }

    // SAFETY: 成功的 `CredReadW` 交出有效 `CREDENTIALW` 及其 blob，直到下方 `CredFree` 前均有效。
    let credential = unsafe { &*pointer };
    let len = credential.CredentialBlobSize as usize;
    let value = if credential.CredentialBlob.is_null() || len == 0 || !len.is_multiple_of(2) {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid credential blob",
        ))
    } else {
        // SAFETY: `CredentialBlob` 指向长度为 `len` 的有效缓冲区。
        let bytes = unsafe { std::slice::from_raw_parts(credential.CredentialBlob, len) };
        let (pairs, _) = bytes.as_chunks::<2>();
        let units: Vec<u16> = pairs.iter().copied().map(u16::from_le_bytes).collect();
        String::from_utf16(&units)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid credential UTF-16"))
    };
    // SAFETY: 不再借用 `credential` 与 blob，释放 `CredReadW` 分配的内存。
    unsafe { CredFree(pointer.cast()) };
    value
}

#[cfg(not(windows))]
fn read_credential(_target: &str) -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Windows Credential Manager is Windows-only",
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Session, date_time, is_session_id};

    #[test]
    fn decodes_valid_session_info_and_rejects_malformed() {
        let path = if cfg!(windows) {
            r"\\.\pipe\bellis-a01-test"
        } else {
            "bellis-a01-test.sock"
        };
        let base = json!({
            "v": 1,
            "sessionId": "a01",
            "channelPath": path,
            "channelKey": "A".repeat(43),
            "launcherPid": 123,
            "startedAt": "2026-11-16T00:00:00.000Z"
        });
        let session = Session::decode(&base.to_string()).unwrap();
        assert_eq!(session.id, "a01");
        assert_eq!(session.launcher_pid, 123);
        assert_eq!(session.started_at, "2026-11-16T00:00:00.000Z");

        for (field, wrong) in [
            ("v", json!(2)),
            ("sessionId", json!("A01")),
            ("launcherPid", json!(0)),
            ("channelKey", json!("no-key")),
            ("channelPath", json!(format!("{path}\0"))),
            ("startedAt", json!("2026-02-29T00:00:00Z")),
            ("extra", json!(null)),
        ] {
            let mut candidate = base.clone();
            candidate[field] = wrong;
            assert!(Session::decode(&candidate.to_string()).is_none(), "{field}");
        }
        let mut missing = base;
        missing.as_object_mut().unwrap().remove("startedAt");
        assert!(Session::decode(&missing.to_string()).is_none());
        assert!(Session::decode("[]").is_none());
    }

    #[test]
    fn validates_rfc3339_and_session_id() {
        assert!(is_session_id("abc0123"));
        assert!(!is_session_id(""));
        assert!(!is_session_id("ABC"));
        assert!(!is_session_id("a".repeat(17).as_str()));

        for accepted in [
            "2024-02-29T00:00:00.012Z",
            "2026-11-16t11:21:30-08:00",
            "2016-12-31T23:59:60Z",
            "2017-01-01T07:59:60+08:00",
        ] {
            assert!(date_time(accepted.as_bytes()).is_some(), "{accepted}");
        }
        for rejected in [
            "2026-02-29T00:00:00Z",
            "2026-11-16T24:00:00Z",
            "2026-11-16T00:00:00",
            "2026-11-16T00:00:00.Z",
            "2026-11-16T00:00:00+24:00",
            "2016-12-31T12:00:60Z",
        ] {
            assert!(date_time(rejected.as_bytes()).is_none(), "{rejected}");
        }
    }
}
