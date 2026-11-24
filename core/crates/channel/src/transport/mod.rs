//! 字节流层：Windows 命名管道放在 [`Transport`] 后面。
//!
//! 不用异步运行时，阻塞/重叠读写都可以带截止时间；`shutdown` 从任一线程唤醒阻塞中的读写。

use std::io;
use std::time::{Duration, Instant};

use crate::error::{ChannelError, ErrorCode};

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::NamedPipeTransport;

/// 双向字节流。实现须允许一个线程读、另一个线程写，并发进行。
pub trait Transport: Send + Sync {
    /// 读入至少 1 个字节并返回字节数；返回 0 表示对端已关闭。
    ///
    /// # Errors
    ///
    /// 超过 `deadline` 时返回 `ErrorKind::TimedOut`，此时没有读入任何字节；
    /// `shutdown` 之后返回 `ErrorKind::NotConnected`。
    fn read(&self, buf: &mut [u8], deadline: Option<Instant>) -> io::Result<usize>;

    /// 写完全部字节。
    ///
    /// # Errors
    ///
    /// 截止时返回 `ErrorKind::TimedOut`，此前可能已写出部分字节。对端关闭或 `shutdown` 后返回错误。
    fn write_all(&self, buf: &[u8], deadline: Option<Instant>) -> io::Result<()>;

    /// 断开连接：唤醒阻塞中的读写，之后的读写都失败。可以重复调用。
    fn shutdown(&self);
}

/// 剩余时间；已过截止时间时返回 `Some(Duration::ZERO)`。
pub(crate) fn remaining(deadline: Option<Instant>) -> Option<Duration> {
    deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()))
}

pub(crate) fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "超过截止时间")
}

pub(crate) fn shut_down() -> io::Error {
    io::Error::new(io::ErrorKind::NotConnected, "连接已断开")
}

/// 连接通道地址（Windows 命名管道）。管道的所有实例都忙时，在 `timeout` 内重试。
///
/// # Errors
///
/// 连不上时为 `connect-failed`。
pub fn open_transport(path: &str, timeout: Duration) -> Result<Box<dyn Transport>, ChannelError> {
    #[cfg(windows)]
    let result =
        NamedPipeTransport::connect(path, timeout).map(|t| Box::new(t) as Box<dyn Transport>);
    #[cfg(not(windows))]
    let result: io::Result<Box<dyn Transport>> = {
        let _ = (path, timeout);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "bellis-channel only supports Windows Named Pipes",
        ))
    };
    result.map_err(|error| {
        ChannelError::new(ErrorCode::ConnectFailed, format!("无法连接通道：{error}"))
    })
}
