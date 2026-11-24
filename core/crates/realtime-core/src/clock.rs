//! 单调时钟：Windows QPC 刻度按 Python `time.perf_counter_ns()` 的算法换算为纳秒，
//! 保证 Rust 实时核与 Python 主进程/操作台共享同一单调时间基。

const NS_PER_SECOND: u128 = 1_000_000_000;
const NS_PER_HUNDRED_NS: u64 = 100;

/// 按 Python `time.perf_counter_ns()` 在 Windows 上的算法把 QPC 刻度换算为纳秒：
/// `ticks * 1e9 / frequency` 向下取整。刻度为负、频率不为正或结果溢出时为 `None`。
#[must_use]
pub fn qpc_ticks_to_ns(ticks: i64, frequency: i64) -> Option<u64> {
    let ticks = u128::try_from(ticks).ok()?;
    let frequency = u128::try_from(frequency).ok().filter(|f| *f > 0)?;
    u64::try_from(ticks * NS_PER_SECOND / frequency).ok()
}

/// 把 WGC 帧或 WASAPI 的 100ns 单位（`SystemRelativeTime`）换算为纳秒；负值或溢出时为 `None`。
#[must_use]
pub fn hundred_ns_to_ns(hundred_ns: i64) -> Option<u64> {
    u64::try_from(hundred_ns)
        .ok()?
        .checked_mul(NS_PER_HUNDRED_NS)
}

/// 现在的时刻（纳秒），与 Python `time.perf_counter_ns()` 同基。
#[cfg(windows)]
#[must_use]
pub fn now_ns() -> u64 {
    use std::sync::OnceLock;
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

    static FREQUENCY: OnceLock<i64> = OnceLock::new();
    let frequency = *FREQUENCY.get_or_init(|| {
        let mut frequency = 0;
        // SAFETY: 只写入局部变量；Windows XP 起此调用不会失败。
        let _ = unsafe { QueryPerformanceFrequency(&raw mut frequency) };
        frequency
    });
    let mut ticks = 0;
    // SAFETY: 只写入局部变量。
    let _ = unsafe { QueryPerformanceCounter(&raw mut ticks) };
    qpc_ticks_to_ns(ticks, frequency).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{hundred_ns_to_ns, now_ns, qpc_ticks_to_ns};
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn qpc_ticks_floor_like_python() {
        assert_eq!(qpc_ticks_to_ns(12_345, 10_000_000), Some(1_234_500));
        assert_eq!(qpc_ticks_to_ns(3, 3_579_545), Some(838));
        assert_eq!(
            qpc_ticks_to_ns(i64::MAX / 2, 1_000_000_000),
            Some(4_611_686_018_427_387_903)
        );
        assert_eq!(qpc_ticks_to_ns(-1, 10_000_000), None);
        assert_eq!(qpc_ticks_to_ns(1, 0), None);
        assert_eq!(qpc_ticks_to_ns(i64::MAX, 1), None);
    }

    #[test]
    fn hundred_ns_units_match_ten_megahertz_qpc() {
        assert_eq!(hundred_ns_to_ns(-1), None);
        assert_eq!(hundred_ns_to_ns(i64::MAX), None);
        for ticks in [0, 1, 99, 10_000_000, 1_234_567_890_123] {
            assert_eq!(hundred_ns_to_ns(ticks), qpc_ticks_to_ns(ticks, 10_000_000));
        }
    }

    #[test]
    fn now_is_monotonic_and_aligned_with_qpc() {
        let mut last = now_ns();
        assert!(last > 0);
        for _ in 0..1_000 {
            let now = now_ns();
            assert!(now >= last, "{now} < {last}");
            last = now;
        }
        let (start, start_ns) = (Instant::now(), now_ns());
        thread::sleep(Duration::from_millis(40));
        let elapsed = u64::try_from(start.elapsed().as_nanos()).unwrap();
        let elapsed_ns = now_ns() - start_ns;
        assert!(elapsed.abs_diff(elapsed_ns) < 10_000_000);
        assert!(elapsed_ns >= 35_000_000);
    }
}
