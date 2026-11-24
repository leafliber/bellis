//! WASAPI 进程回环：按进程 ID 仅采集目标进程及其子进程的声音（Windows 10 build 20348+）。

use std::mem::ManuallyDrop;
use std::ptr;
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, HANDLE, WAIT_EVENT, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient,
    IAudioClient, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{BLOB, COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, PROCESS_SYNCHRONIZE, WaitForMultipleObjects, WaitForSingleObject,
};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{HRESULT, IUnknown, Interface};

use super::{AudioError, AudioFormat, AudioPacket, AudioSource};
use crate::clock;

const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(5);
const BUFFER_DURATION_HNS: i64 = 2_000_000;

fn os(context: &'static str) -> impl FnOnce(windows::core::Error) -> AudioError {
    move |error| AudioError::Os {
        context,
        code: error.code().0,
        message: error.message(),
    }
}

mod completion {
    #![allow(
        clippy::inline_always,
        clippy::ref_as_ptr,
        reason = "windows crate 的 implement 宏生成代码"
    )]

    use std::sync::mpsc::Sender;
    use std::sync::{Mutex, PoisonError};

    use windows::Win32::Media::Audio::{
        IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
        IActivateAudioInterfaceCompletionHandler_Impl,
    };
    use windows::core::{Ref, implement};

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    pub(super) struct Activated {
        pub(super) done: Mutex<Option<Sender<()>>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
        fn ActivateCompleted(
            &self,
            _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            let sender = self
                .done
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some(sender) = sender {
                let _ = sender.send(());
            }
            Ok(())
        }
    }
}

use completion::Activated;

#[allow(clippy::cast_possible_truncation, reason = "格式标签是 3")]
const FORMAT_TAG_FLOAT: u16 = WAVE_FORMAT_IEEE_FLOAT as u16;

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: 句柄由本模块创建或打开，只关闭一次。
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct Apartment;

impl Apartment {
    fn enter() -> Result<Self, AudioError> {
        // SAFETY: 以 MTA 初始化本线程，drop 时对称反初始化。
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        result.ok().map_err(os("CoInitializeEx"))?;
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: 与 `enter` 成功调用配对。
        unsafe { CoUninitialize() };
    }
}

/// WASAPI 进程回环音频源：只采目标进程及其子进程的声音。
pub struct ProcessLoopback {
    capture: IAudioCaptureClient,
    client: IAudioClient,
    buffer_event: OwnedHandle,
    process: OwnedHandle,
    format: AudioFormat,
    process_id: u32,
    _apartment: Apartment,
}

impl ProcessLoopback {
    /// 采进程 `process_id` 及其子进程的声音，以 `format` 交出（F32，系统转换）。
    ///
    /// # Errors
    ///
    /// 进程已退出、系统不支持或系统调用失败时返回 [`AudioError`]。
    pub fn new(process_id: u32, format: AudioFormat) -> Result<Self, AudioError> {
        let channels = u16::try_from(format.channels)
            .ok()
            .filter(|&channels| channels > 0)
            .ok_or_else(|| AudioError::Unsupported(format!("{} channels", format.channels)))?;
        if format.sample_rate == 0 {
            return Err(AudioError::Unsupported("a sample rate of 0 Hz".into()));
        }
        let apartment = Apartment::enter()?;
        // SAFETY: 只请求等待权限；持有句柄防止 PID 被复用。
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, process_id) }
            .map(OwnedHandle)
            .map_err(|error| {
                if error.code() == ERROR_INVALID_PARAMETER.to_hresult() {
                    AudioError::ProcessExited
                } else {
                    os("OpenProcess")(error)
                }
            })?;
        if exited(&process) {
            return Err(AudioError::ProcessExited);
        }
        let client = activate(process_id)?;
        let block_align = channels * 4;
        let wave = WAVEFORMATEX {
            wFormatTag: FORMAT_TAG_FLOAT,
            nChannels: channels,
            nSamplesPerSec: format.sample_rate,
            nAvgBytesPerSec: format.sample_rate * u32::from(block_align),
            nBlockAlign: block_align,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        let flags = AUDCLNT_STREAMFLAGS_LOOPBACK
            | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        // SAFETY: `wave` 有效；进程回环周期参数为 0。
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                flags,
                BUFFER_DURATION_HNS,
                0,
                &raw const wave,
                None,
            )
        }
        .map_err(os("IAudioClient::Initialize"))?;
        // SAFETY: 自动复位匿名事件。
        let buffer_event = unsafe { CreateEventW(None, false, false, None) }
            .map(OwnedHandle)
            .map_err(os("CreateEventW"))?;
        // SAFETY: 事件句柄在音频源生命期内有效。
        unsafe { client.SetEventHandle(buffer_event.0) }
            .map_err(os("IAudioClient::SetEventHandle"))?;
        // SAFETY: 客户端已初始化。
        let capture: IAudioCaptureClient =
            unsafe { client.GetService() }.map_err(os("IAudioClient::GetService"))?;
        // SAFETY: 客户端已初始化并设置事件。
        unsafe { client.Start() }.map_err(os("IAudioClient::Start"))?;
        Ok(Self {
            capture,
            client,
            buffer_event,
            process,
            format,
            process_id,
            _apartment: apartment,
        })
    }

    #[must_use]
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    fn take_packet(&mut self, packet: &mut AudioPacket) -> Result<bool, AudioError> {
        // SAFETY: 客户端已开始采集。
        let pending =
            unsafe { self.capture.GetNextPacketSize() }.map_err(os("GetNextPacketSize"))?;
        if pending == 0 {
            return Ok(false);
        }
        let mut data = ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        let mut qpc_position = 0u64;
        // SAFETY: 输出参数均为局部变量；`data` 在 ReleaseBuffer 之前有效。
        unsafe {
            self.capture.GetBuffer(
                &raw mut data,
                &raw mut frames,
                &raw mut flags,
                None,
                Some(&raw mut qpc_position),
            )
        }
        .map_err(os("IAudioCaptureClient::GetBuffer"))?;
        let bytes = frames as usize * self.format.bytes_per_sample();
        packet.data.clear();
        if flags & flag(AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data.is_null() {
            packet.data.resize(bytes, 0);
        } else {
            // SAFETY: WASAPI 保证 `data` 指向 `bytes` 字节且在 ReleaseBuffer 之前有效。
            packet
                .data
                .extend_from_slice(unsafe { std::slice::from_raw_parts(data, bytes) });
        }
        // SAFETY: 释放刚取出的全部采样点。
        unsafe { self.capture.ReleaseBuffer(frames) }
            .map_err(os("IAudioCaptureClient::ReleaseBuffer"))?;
        packet.sample_count = frames;
        packet.discontinuity = flags & flag(AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0;
        packet.capture_ns =
            if flags & flag(AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0 || qpc_position == 0 {
                clock::now_ns().saturating_sub(self.format.duration_ns(u64::from(frames)))
            } else {
                qpc_position.saturating_mul(100)
            };
        Ok(true)
    }
}

impl AudioSource for ProcessLoopback {
    fn next_packet(
        &mut self,
        timeout: Duration,
        packet: &mut AudioPacket,
    ) -> Result<bool, AudioError> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.take_packet(packet)? {
                return Ok(true);
            }
            if exited(&self.process) {
                return Err(AudioError::ProcessExited);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            let millis = u32::try_from(remaining.as_millis().max(1)).unwrap_or(u32::MAX);
            let handles = [self.buffer_event.0, self.process.0];
            // SAFETY: 两个句柄在音频源生命期内有效。
            let woke = unsafe { WaitForMultipleObjects(&handles, false, millis) };
            match woke {
                WAIT_OBJECT_0 => {}
                woke if woke == WAIT_EVENT(WAIT_OBJECT_0.0 + 1) => {
                    return Err(AudioError::ProcessExited);
                }
                WAIT_TIMEOUT => {}
                _ => {
                    return Err(AudioError::Os {
                        context: "WaitForMultipleObjects",
                        code: woke.0.cast_signed(),
                        message: std::io::Error::last_os_error().to_string(),
                    });
                }
            }
        }
    }
}

impl Drop for ProcessLoopback {
    fn drop(&mut self) {
        // SAFETY: 客户端已初始化。
        let _ = unsafe { self.client.Stop() };
    }
}

fn flag(value: windows::Win32::Media::Audio::_AUDCLNT_BUFFERFLAGS) -> u32 {
    value.0.cast_unsigned()
}

fn exited(process: &OwnedHandle) -> bool {
    // SAFETY: 句柄带等待权限，超时为 0 仅查看状态。
    let status = unsafe { WaitForSingleObject(process.0, 0) };
    status == WAIT_OBJECT_0
}

fn activate(process_id: u32) -> Result<IAudioClient, AudioError> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: process_id,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let blob = BLOB {
        cbSize: u32::try_from(size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>())
            .expect("activation parameters are small"),
        pBlobData: (&raw const params).cast_mut().cast(),
    };
    let variant = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { blob },
            }),
        },
    });
    let (sender, done) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activated {
        done: Mutex::new(Some(sender)),
    }
    .into();
    // SAFETY: `variant` 与 `params` 存活至激活完成或超时；回调对象是 agile 的。
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&raw const *variant),
            &handler,
        )
    }
    .map_err(unsupported_or(os("ActivateAudioInterfaceAsync")))?;
    if done.recv_timeout(ACTIVATE_TIMEOUT).is_err() {
        return Err(AudioError::Os {
            context: "ActivateAudioInterfaceAsync",
            code: 0,
            message: format!(
                "activation did not complete within {}s",
                ACTIVATE_TIMEOUT.as_secs()
            ),
        });
    }
    let mut result = HRESULT(0);
    let mut activated: Option<IUnknown> = None;
    // SAFETY: 激活已完成；输出参数均为局部变量。
    unsafe { operation.GetActivateResult(&raw mut result, &raw mut activated) }
        .map_err(os("GetActivateResult"))?;
    result
        .ok()
        .map_err(unsupported_or(os("ActivateAudioInterfaceAsync")))?;
    activated
        .ok_or_else(|| AudioError::Os {
            context: "GetActivateResult",
            code: 0,
            message: "no interface".into(),
        })?
        .cast()
        .map_err(os("IUnknown::QueryInterface(IAudioClient)"))
}

fn unsupported_or(
    otherwise: impl FnOnce(windows::core::Error) -> AudioError,
) -> impl FnOnce(windows::core::Error) -> AudioError {
    use windows::Win32::Foundation::{E_INVALIDARG, E_NOTIMPL};
    move |error| {
        if error.code() == E_NOTIMPL || error.code() == E_INVALIDARG {
            AudioError::Unsupported(format!("process loopback capture: {}", error.message()))
        } else {
            otherwise(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ProcessLoopback;
    use crate::audio::{AudioError, AudioFormat};

    const FORMAT: AudioFormat = AudioFormat {
        sample_rate: 48_000,
        channels: 2,
    };

    #[test]
    fn missing_process_and_bad_formats_are_rejected() {
        assert!(matches!(
            ProcessLoopback::new(0, FORMAT),
            Err(AudioError::ProcessExited)
        ));
        assert!(matches!(
            ProcessLoopback::new(
                std::process::id(),
                AudioFormat {
                    sample_rate: 0,
                    channels: 1,
                }
            ),
            Err(AudioError::Unsupported(_))
        ));
    }
}
