//! Windows 命名管道的客户端字节流。
//!
//! 句柄以 `FILE_FLAG_OVERLAPPED` 打开：每次读写发起重叠 IO，同时等待完成事件与“断开”事件，
//! 到截止时间或被断开时以 `CancelIoEx` 取消并等取消完成，已读到的字节不丢。
//! 打开时带 `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`：提权客户端连到被抢注管道时，
//! 对端最多只能识别、不能冒充令牌。

use std::io;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_MORE_DATA, ERROR_NO_DATA,
    ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ,
    GENERIC_WRITE, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT, WIN32_ERROR,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_NONE, OPEN_EXISTING, ReadFile,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::WaitNamedPipeW;
use windows::Win32::System::Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects};
use windows::core::{HSTRING, PCWSTR};

use super::{Transport, remaining, shut_down, timed_out};

/// 不随析构关闭的内核句柄，由持有者决定何时关闭。
struct RawHandle(HANDLE);

// SAFETY: 内核句柄只是一个进程内的索引，Win32 允许任意线程使用；持有者保证关闭后不再使用。
unsafe impl Send for RawHandle {}
// SAFETY: 同上。
unsafe impl Sync for RawHandle {}

/// 内核句柄：可以在线程间传递与共享，析构时关闭。
struct Handle(HANDLE);

// SAFETY: 内核句柄只是一个进程内的索引，Win32 允许任意线程使用；本模块保证关闭后不再使用。
unsafe impl Send for Handle {}
// SAFETY: 同上；并发的读与写各用自己的 OVERLAPPED 与事件，这是重叠 IO 支持的用法。
unsafe impl Sync for Handle {}

impl Handle {
    fn event() -> io::Result<Self> {
        // SAFETY: 参数都是合法值；手动复位、初始未触发、匿名。
        let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) };
        event.map(Self).map_err(|error| os_error(&error))
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: 句柄由本结构独占，此后不再使用。
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn win32(error: &windows::core::Error) -> Option<WIN32_ERROR> {
    WIN32_ERROR::from_error(error)
}

fn is(error: &windows::core::Error, code: WIN32_ERROR) -> bool {
    win32(error) == Some(code)
}

fn os_error(error: &windows::core::Error) -> io::Error {
    match win32(error) {
        Some(code) => io::Error::from_raw_os_error(code.0.cast_signed()),
        None => io::Error::other(error.message()),
    }
}

fn is_disconnected(error: &windows::core::Error) -> bool {
    is(error, ERROR_BROKEN_PIPE) || is(error, ERROR_PIPE_NOT_CONNECTED) || is(error, ERROR_NO_DATA)
}

fn wait_millis(left: Option<Duration>) -> u32 {
    match left {
        None => INFINITE,
        Some(left) => u32::try_from(left.as_nanos().div_ceil(1_000_000))
            .unwrap_or(INFINITE - 1)
            .min(INFINITE - 1),
    }
}

enum Outcome {
    Done(usize),
    Eof,
    Interrupted { closed: bool },
}

pub struct NamedPipeTransport {
    pipe: RawHandle,
    read_event: Handle,
    write_event: Handle,
    close_event: Handle,
    read_lock: Mutex<()>,
    write_lock: Mutex<()>,
    closed: AtomicBool,
}

impl NamedPipeTransport {
    /// 连接命名管道；所有实例都忙时在 `timeout` 内等待重试。
    ///
    /// # Errors
    ///
    /// 管道不存在、无权访问或超时时返回 IO 错误。
    pub fn connect(path: &str, timeout: Duration) -> io::Result<Self> {
        let deadline = Instant::now() + timeout;
        let name = HSTRING::from(path);
        let (read_event, write_event, close_event) =
            (Handle::event()?, Handle::event()?, Handle::event()?);
        let pipe = loop {
            // SAFETY: name 是以 NUL 结尾的宽字符串，其余参数都是合法常量。
            let opened = unsafe {
                CreateFileW(
                    &name,
                    (GENERIC_READ | GENERIC_WRITE).0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    None,
                )
            };
            match opened {
                Ok(handle) => break RawHandle(handle),
                Err(error) if is(&error, ERROR_PIPE_BUSY) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(os_error(&error));
                    }
                    // SAFETY: name 是以 NUL 结尾的宽字符串。返回值不重要：失败时下一轮 CreateFileW 会报告。
                    let _ = unsafe { WaitNamedPipeW(&name, wait_millis(Some(left))) };
                }
                Err(error) => return Err(os_error(&error)),
            }
        };
        Ok(Self {
            pipe,
            read_event,
            write_event,
            close_event,
            read_lock: Mutex::new(()),
            write_lock: Mutex::new(()),
            closed: AtomicBool::new(false),
        })
    }

    fn finish(
        &self,
        overlapped: &OVERLAPPED,
        event: &Handle,
        deadline: Option<Instant>,
    ) -> io::Result<Outcome> {
        let handles = [event.0, self.close_event.0];
        let wait = loop {
            // SAFETY: 两个句柄在 self 存活期间都有效。
            let wait = unsafe {
                WaitForMultipleObjects(&handles, false, wait_millis(remaining(deadline)))
            };
            if wait != WAIT_TIMEOUT || remaining(deadline).is_none_or(|left| left.is_zero()) {
                break wait;
            }
        };
        let interrupted = wait != WAIT_OBJECT_0;
        if interrupted {
            // SAFETY: overlapped 指向本次仍在进行的 IO；IO 已完成时取消无效果，返回值不重要。
            let _ = unsafe { CancelIoEx(self.pipe.0, Some(overlapped)) };
        }
        let mut transferred = 0u32;
        // SAFETY: overlapped 与其事件有效；bWait 为真，直到 IO 完成或取消完成才返回。
        let result =
            unsafe { GetOverlappedResult(self.pipe.0, overlapped, &raw mut transferred, true) };
        let closed = self.closed.load(Ordering::Acquire);
        match result {
            Ok(()) if transferred > 0 || !interrupted => Ok(Outcome::Done(transferred as usize)),
            Ok(()) => Ok(Outcome::Interrupted { closed }),
            Err(error) if is(&error, ERROR_MORE_DATA) => Ok(Outcome::Done(transferred as usize)),
            Err(error) if is(&error, ERROR_OPERATION_ABORTED) => {
                Ok(Outcome::Interrupted { closed })
            }
            Err(error) if is_disconnected(&error) => Ok(Outcome::Eof),
            Err(error) => Err(os_error(&error)),
        }
    }
}

impl Transport for NamedPipeTransport {
    fn read(&self, buf: &mut [u8], deadline: Option<Instant>) -> io::Result<usize> {
        let _guard = self
            .read_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let length = buf.len().min(u32::MAX as usize);
        loop {
            if self.closed.load(Ordering::Acquire) {
                return Err(shut_down());
            }
            let mut overlapped = OVERLAPPED {
                hEvent: self.read_event.0,
                ..Default::default()
            };
            // SAFETY: 缓冲区与 overlapped 都活到 finish 确认 IO 结束之后；句柄未关闭（持有读锁时检查过）。
            let started = unsafe {
                ReadFile(
                    self.pipe.0,
                    Some(&mut buf[..length]),
                    None,
                    Some(&raw mut overlapped),
                )
            };
            match started {
                Ok(()) => {}
                Err(error) if is(&error, ERROR_IO_PENDING) => {}
                Err(error) if is_disconnected(&error) => return Ok(0),
                Err(error) => return Err(os_error(&error)),
            }
            match self.finish(&overlapped, &self.read_event, deadline)? {
                Outcome::Done(0) => {}
                Outcome::Done(count) => return Ok(count),
                Outcome::Eof => return Ok(0),
                Outcome::Interrupted { closed: true } => return Err(shut_down()),
                Outcome::Interrupted { closed: false } => return Err(timed_out()),
            }
        }
    }

    fn write_all(&self, mut buf: &[u8], deadline: Option<Instant>) -> io::Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !buf.is_empty() {
            if self.closed.load(Ordering::Acquire) {
                return Err(shut_down());
            }
            if remaining(deadline).is_some_and(|left| left.is_zero()) {
                return Err(timed_out());
            }
            let length = buf.len().min(u32::MAX as usize);
            let mut overlapped = OVERLAPPED {
                hEvent: self.write_event.0,
                ..Default::default()
            };
            // SAFETY: 同 read。
            let started = unsafe {
                WriteFile(
                    self.pipe.0,
                    Some(&buf[..length]),
                    None,
                    Some(&raw mut overlapped),
                )
            };
            match started {
                Ok(()) => {}
                Err(error) if is(&error, ERROR_IO_PENDING) => {}
                Err(error) => return Err(os_error(&error)),
            }
            match self.finish(&overlapped, &self.write_event, deadline)? {
                Outcome::Done(0) => return Err(io::ErrorKind::WriteZero.into()),
                Outcome::Done(count) => buf = &buf[count..],
                Outcome::Eof => return Err(io::Error::from(io::ErrorKind::BrokenPipe)),
                Outcome::Interrupted { closed: true } => return Err(shut_down()),
                Outcome::Interrupted { closed: false } => return Err(timed_out()),
            }
        }
        Ok(())
    }

    fn shutdown(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        // SAFETY: 事件句柄有效。唤醒正在等待的读写，它们取消各自的 IO 后释放锁。
        let _ = unsafe { SetEvent(self.close_event.0) };
        let _read = self
            .read_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _write = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // SAFETY: 句柄有效；closed 已置位，此后没有任何地方再用它，Drop 也不会再关一次。
        let _ = unsafe { CloseHandle(self.pipe.0) };
    }
}

impl Drop for NamedPipeTransport {
    fn drop(&mut self) {
        if !*self.closed.get_mut() {
            // SAFETY: 未经 shutdown 关闭过；独占访问，此后不再使用。
            let _ = unsafe { CloseHandle(self.pipe.0) };
        }
    }
}
