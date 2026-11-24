//! base64url（RFC 4648 第 5 节）编码，无填充。

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub(crate) fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let chars = chunk.len() + 1;
        for i in 0..chars {
            let index = (n >> (18 - 6 * i)) & 0x3f;
            out.push(char::from(ALPHABET[index as usize]));
        }
    }
    out
}

fn value(c: u8) -> Option<u32> {
    ALPHABET
        .iter()
        .position(|&a| a == c)
        .and_then(|p| u32::try_from(p).ok())
}

/// 43 个字符的 base64url 是否合法（字母表内）。
pub(crate) fn is_bytes32_text(text: &str) -> bool {
    text.len() == 43 && text.bytes().all(|c| value(c).is_some())
}

/// 解码 43 个字符为 32 字节；忽略最后一个字符未用到的低 2 位。
pub(crate) fn decode_bytes32(text: &str) -> Option<[u8; 32]> {
    if !is_bytes32_text(text) {
        return None;
    }
    let mut bits: u64 = 0;
    let mut count = 0u32;
    let mut out = [0u8; 32];
    let mut written = 0;
    for c in text.bytes() {
        bits = ((bits << 6) | u64::from(value(c)?)) & 0xffff;
        count += 6;
        if count >= 8 {
            count -= 8;
            if written < out.len() {
                out[written] = u8::try_from((bits >> count) & 0xff).ok()?;
                written += 1;
            }
        }
    }
    (written == out.len()).then_some(out)
}
