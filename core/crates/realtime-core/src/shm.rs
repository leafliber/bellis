//! Windows 命名共享内存（`OpenFileMappingW` + `MapViewOfFile`），全部读写经原子操作完成。
//!
//! 生产路径只按名字打开主进程创建的文件映射；测试辅助创建器严格隔离在 `#[cfg(test)]` 内。

use std::io;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering};

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Memory::{
    FILE_MAP_READ, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile, OpenFileMappingW,
    UnmapViewOfFile,
};
use windows::core::HSTRING;

fn os_error(error: &windows::core::Error) -> io::Error {
    io::Error::from_raw_os_error(error.code().0 & 0xFFFF)
}

/// 一段映射到本进程的共享内存；drop 时解除映射，不删除共享内存本身。
#[derive(Debug)]
pub struct SharedMemory {
    ptr: NonNull<u8>,
    len: usize,
}

// SAFETY: 映射在整个生命期内有效，与线程无关；经 `&self` 的访问都是原子操作。
unsafe impl Send for SharedMemory {}
// SAFETY: 同上；多线程并发访问均为原子操作，无数据竞争。
unsafe impl Sync for SharedMemory {}

impl SharedMemory {
    /// 打开名为 `name` 的共享内存，映射它开头的 `len` 字节。
    ///
    /// # Errors
    ///
    /// `len` 为 0、名字含 NUL、共享内存不存在、小于 `len` 或映射失败时返回系统错误。
    ///
    /// # Panics
    ///
    /// 映射起点未按 8 字节对齐时 panic（Windows 页映射总是按页对齐）。
    pub fn open(name: &str, len: usize) -> io::Result<Self> {
        if len == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot map zero bytes",
            ));
        }
        if name.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "shared memory name contains NUL",
            ));
        }
        let access = FILE_MAP_READ | FILE_MAP_WRITE;
        // SAFETY: HSTRING 以 NUL 结尾；不继承句柄。
        let handle = unsafe { OpenFileMappingW(access.0, false, &HSTRING::from(name)) }
            .map_err(|error| os_error(&error))?;
        // SAFETY: `handle` 为刚打开的映射句柄，`len > 0`；映射小于 `len` 时返回空。
        let view = unsafe { MapViewOfFile(handle, access, 0, 0, len) };
        let mapped = NonNull::new(view.Value.cast::<u8>()).ok_or_else(io::Error::last_os_error);
        // SAFETY: 视图不依赖文件映射句柄保持打开；此处只关闭一次。
        let _ = unsafe { CloseHandle(handle) };
        let ptr = mapped?;
        assert!(
            ptr.as_ptr().addr().is_multiple_of(8),
            "mapping is misaligned"
        );
        Ok(Self { ptr, len })
    }

    fn range(&self, offset: usize, len: usize) -> *mut u8 {
        assert!(
            offset.checked_add(len).is_some_and(|end| end <= self.len),
            "{offset}+{len} is outside the {}-byte mapping",
            self.len
        );
        // SAFETY: 上面已核对 `offset + len <= self.len`。
        unsafe { self.ptr.as_ptr().add(offset) }
    }

    /// `offset` 处的原子 `u64`。
    ///
    /// # Panics
    ///
    /// `offset` 未按 8 字节对齐或越界时 panic。
    #[must_use]
    pub fn u64_at(&self, offset: usize) -> &AtomicU64 {
        assert!(offset.is_multiple_of(8), "u64 at {offset} is misaligned");
        let ptr = self.range(offset, 8);
        // SAFETY: 已检查范围内且 8 字节对齐，映射存活期覆盖 `&self`。
        unsafe { AtomicU64::from_ptr(ptr.cast()) }
    }

    /// `offset` 处的原子 `u32`。
    ///
    /// # Panics
    ///
    /// `offset` 未按 4 字节对齐或越界时 panic。
    #[must_use]
    pub fn u32_at(&self, offset: usize) -> &AtomicU32 {
        assert!(offset.is_multiple_of(4), "u32 at {offset} is misaligned");
        let ptr = self.range(offset, 4);
        // SAFETY: 已检查范围内且 4 字节对齐，映射存活期覆盖 `&self`。
        unsafe { AtomicU32::from_ptr(ptr.cast()) }
    }

    /// 以 Relaxed 原子写把 `src` 复制到 `offset` 起；对齐部分按 8 字节写入。
    ///
    /// # Panics
    ///
    /// 越界时 panic。
    pub fn store(&self, offset: usize, src: &[u8]) {
        let base = self.range(offset, src.len());
        let head = base.align_offset(8).min(src.len());
        let (head_bytes, rest) = src.split_at(head);
        let (words, tail_bytes) = rest.as_chunks::<8>();
        for (i, byte) in head_bytes.iter().enumerate() {
            // SAFETY: `base + i` 在核对过的范围内。
            unsafe { AtomicU8::from_ptr(base.add(i)) }.store(*byte, Ordering::Relaxed);
        }
        let mut at = head;
        for word in words {
            let word = u64::from_ne_bytes(*word);
            // SAFETY: `base + at` 在范围内且 8 字节对齐。
            unsafe { AtomicU64::from_ptr(base.add(at).cast()) }.store(word, Ordering::Relaxed);
            at += 8;
        }
        for byte in tail_bytes {
            // SAFETY: `base + at` 在范围内。
            unsafe { AtomicU8::from_ptr(base.add(at)) }.store(*byte, Ordering::Relaxed);
            at += 1;
        }
    }
}

impl Drop for SharedMemory {
    fn drop(&mut self) {
        let view = MEMORY_MAPPED_VIEW_ADDRESS {
            Value: self.ptr.as_ptr().cast(),
        };
        // SAFETY: `ptr` 来自 `MapViewOfFile`，此后不再访问。
        let _ = unsafe { UnmapViewOfFile(view) };
    }
}

#[cfg(test)]
impl SharedMemory {
    pub(crate) fn load(&self, offset: usize, dst: &mut [u8]) {
        let base = self.range(offset, dst.len());
        let head = base.align_offset(8).min(dst.len());
        let (head_bytes, rest) = dst.split_at_mut(head);
        let (words, tail_bytes) = rest.as_chunks_mut::<8>();
        for (i, byte) in head_bytes.iter_mut().enumerate() {
            // SAFETY: 同 `store`。
            *byte = unsafe { AtomicU8::from_ptr(base.add(i)) }.load(Ordering::Relaxed);
        }
        let mut at = head;
        for word in words {
            // SAFETY: 同 `store`。
            *word = unsafe { AtomicU64::from_ptr(base.add(at).cast()) }
                .load(Ordering::Relaxed)
                .to_ne_bytes();
            at += 8;
        }
        for byte in tail_bytes {
            // SAFETY: 同 `store`。
            *byte = unsafe { AtomicU8::from_ptr(base.add(at)) }.load(Ordering::Relaxed);
            at += 1;
        }
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::io;

    use windows::Win32::Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows::Win32::System::Memory::{CreateFileMappingW, PAGE_READWRITE};
    use windows::core::HSTRING;

    use super::os_error;

    #[derive(Debug)]
    pub(crate) struct Created {
        handle: HANDLE,
    }

    impl Created {
        pub(crate) fn new(name: &str, len: usize) -> io::Result<Self> {
            let len = u64::try_from(len).map_err(io::Error::other)?;
            #[allow(clippy::cast_possible_truncation, reason = "拆成高低两个 32 位")]
            let (high, low) = ((len >> 32) as u32, len as u32);
            // SAFETY: 页面文件后备的命名映射；HSTRING 以 NUL 结尾。
            let handle = unsafe {
                CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    None,
                    PAGE_READWRITE,
                    high,
                    low,
                    &HSTRING::from(name),
                )
            }
            .map_err(|error| os_error(&error))?;
            let created = Self { handle };
            // SAFETY: 只读本线程最后错误码。
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            Ok(created)
        }
    }

    impl Drop for Created {
        fn drop(&mut self) {
            // SAFETY: 句柄来自 CreateFileMappingW，此后不再使用。
            let _ = unsafe { CloseHandle(self.handle) };
        }
    }
}
