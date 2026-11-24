//! Bellis V2 确定性实时采集、共享内存环与安全输入实时核。
//!
//! 将原 V1 分散的时钟、共享内存、帧环、音频环、窗口采集、进程回环与安全输入控制收拢在同一 crate
//! 的清晰模块边界内；全部外部通信复用 `bellis-channel` 唯一通道实现与精简 JSON-RPC 2.0 协议。

/// 写一行带前缀的日志到 stderr；写失败时丢弃，绝不 panic。
macro_rules! log {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), "realtime-core: {}", format_args!($($arg)*));
    }};
}

pub mod audio;
pub mod capture;
pub mod clock;
pub mod control;
pub mod input;
pub mod panic_exit;
pub mod protocol;
pub mod ring;
pub mod session;
pub mod shm;

pub use panic_exit::{PANIC_EXIT_CODE, install_panic_exit};

/// 底层通道协议版本标识（`bellis-channel/1`）。
#[must_use]
pub fn channel_protocol() -> &'static str {
    bellis_channel::PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::channel_protocol;

    #[test]
    fn links_against_channel_protocol() {
        assert_eq!(channel_protocol(), "bellis-channel/1");
    }
}
