//! Per-Monitor DPI Aware v2 声明：保证所有坐标均为物理像素。

use windows::Win32::Foundation::HANDLE;
use windows::Win32::UI::HiDpi::{
    AreDpiAwarenessContextsEqual, DPI_AWARENESS_CONTEXT,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiAwarenessContextForProcess,
    GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext,
};

/// 将当前进程声明为 Per-Monitor DPI Aware v2（已是 v2 时视为成功）。
///
/// # Errors
///
/// 进程已处于其它 DPI 感知模式时返回系统错误。
pub fn declare_per_monitor_aware_v2() -> windows::core::Result<()> {
    // SAFETY: 参数是系统定义的伪句柄常量。
    let declared =
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if declared.is_err() && process_is_per_monitor_aware_v2() {
        return Ok(());
    }
    declared
}

#[must_use]
pub fn process_is_per_monitor_aware_v2() -> bool {
    // SAFETY: 空句柄查询当前进程；返回的上下文是不需释放的伪句柄。
    is_v2(unsafe { GetDpiAwarenessContextForProcess(HANDLE::default()) })
}

#[must_use]
pub fn thread_is_per_monitor_aware_v2() -> bool {
    // SAFETY: 只读当前线程 DPI 感知状态。
    is_v2(unsafe { GetThreadDpiAwarenessContext() })
}

fn is_v2(context: DPI_AWARENESS_CONTEXT) -> bool {
    // SAFETY: 仅比较两个系统伪句柄。
    unsafe { AreDpiAwarenessContextsEqual(context, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
        .as_bool()
}

#[cfg(test)]
mod tests {
    use super::{
        declare_per_monitor_aware_v2, process_is_per_monitor_aware_v2,
        thread_is_per_monitor_aware_v2,
    };

    #[test]
    fn declares_per_monitor_aware_v2_idempotently() {
        declare_per_monitor_aware_v2().expect("first declaration");
        assert!(process_is_per_monitor_aware_v2());
        assert!(thread_is_per_monitor_aware_v2());
        declare_per_monitor_aware_v2().expect("repeat declaration");
    }
}
