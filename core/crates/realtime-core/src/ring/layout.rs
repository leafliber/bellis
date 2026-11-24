//! 帧环与音频环的共享内存二进制布局定义（`#[repr(C)]`，小端，零填充）。
//!
//! 跨语言偏移表由 `tests/fixtures/realtime_core/ring_layout.json` 固定，并由 Rust 单元测试逐字节断言。

pub mod frame {
    use std::mem::size_of;
    use std::sync::atomic::AtomicU64;

    /// 帧环头部 magic：小端读出的 `b"BGRTRING"`。
    pub const MAGIC: u64 = u64::from_le_bytes(*b"BGRTRING");
    /// 布局版本：头部、槽头部或下列常量变化时加一。
    pub const LAYOUT_VERSION: u32 = 1;
    /// 槽 0 相对共享内存起点的偏移。
    pub const SLOTS_OFFSET: u64 = 64;
    /// 像素相对槽起点的偏移。
    pub const SLOT_PIXELS_OFFSET: u64 = 64;
    /// 槽跨度的对齐字节数。
    pub const SLOT_ALIGN: u64 = 64;
    /// 像素格式 BGRA8：每像素 4 字节，依次为 B、G、R、A。
    pub const PIXEL_FORMAT_BGRA8: u32 = 1;

    /// 帧环头部。主进程创建时写入除 `write_seq` 外的全部字段；`write_seq` 只由实时核写。
    #[repr(C)]
    #[derive(Debug)]
    pub struct FrameRingHeader {
        pub magic: u64,
        pub layout_version: u32,
        pub slot_count: u32,
        pub slot_stride: u64,
        pub max_width: u32,
        pub max_height: u32,
        pub write_seq: AtomicU64,
    }

    /// 帧环槽头部。只由实时核写，以 `seq` 作单写者多读者的 seqlock。
    #[repr(C)]
    #[derive(Debug)]
    pub struct FrameSlotHeader {
        pub seq: AtomicU64,
        pub frame_number: u64,
        pub capture_ns: u64,
        pub transform_version: u64,
        pub width: u32,
        pub height: u32,
        pub row_stride: u32,
        pub pixel_format: u32,
    }

    const _: () = assert!(size_of::<FrameRingHeader>() as u64 <= SLOTS_OFFSET);
    const _: () = assert!(size_of::<FrameSlotHeader>() as u64 <= SLOT_PIXELS_OFFSET);
    const _: () = assert!(SLOTS_OFFSET.is_multiple_of(SLOT_ALIGN));
    const _: () = assert!(SLOT_PIXELS_OFFSET.is_multiple_of(SLOT_ALIGN));
}

pub mod audio {
    use std::mem::size_of;
    use std::sync::atomic::AtomicU64;

    /// 音频环头部 magic：小端读出的 `b"BGRAUDIO"`。
    pub const MAGIC: u64 = u64::from_le_bytes(*b"BGRAUDIO");
    /// 布局版本：头部、块头部或下列常量变化时加一。
    pub const LAYOUT_VERSION: u32 = 1;
    /// 块槽 0 相对共享内存起点的偏移。
    pub const BLOCKS_OFFSET: u64 = 64;
    /// 样本值相对块槽起点的偏移。
    pub const BLOCK_SAMPLES_OFFSET: u64 = 64;
    /// 块槽跨度的对齐字节数。
    pub const BLOCK_ALIGN: u64 = 64;
    /// 样本格式 F32：32 位 IEEE 浮点，各声道交错排列。
    pub const SAMPLE_FORMAT_F32: u32 = 1;
    /// 一个 F32 样本值的字节数。
    pub const BYTES_PER_VALUE: u32 = 4;
    /// 声道数上限。
    pub const MAX_CHANNELS: u32 = 2;
    /// 采样率下限（Hz）。
    pub const MIN_SAMPLE_RATE: u32 = 8_000;
    /// 采样率上限（Hz）。
    pub const MAX_SAMPLE_RATE: u32 = 192_000;
    /// 块标志：这一块与上一块之间不连续。
    pub const FLAG_DISCONTINUITY: u32 = 1;
    /// 已定义的全部块标志。
    pub const KNOWN_FLAGS: u32 = FLAG_DISCONTINUITY;

    /// 音频环头部。主进程创建时写入除 `write_seq` 外的全部字段；`write_seq` 只由实时核写。
    #[repr(C)]
    #[derive(Debug)]
    pub struct AudioRingHeader {
        pub magic: u64,
        pub layout_version: u32,
        pub block_count: u32,
        pub block_stride: u64,
        pub block_capacity: u32,
        pub sample_rate: u32,
        pub channels: u32,
        pub sample_format: u32,
        pub write_seq: AtomicU64,
    }

    /// 音频块槽头部。只由实时核写，以 `seq` 作 seqlock。
    #[repr(C)]
    #[derive(Debug)]
    pub struct AudioBlockHeader {
        pub seq: AtomicU64,
        pub block_number: u64,
        pub capture_ns: u64,
        pub sample_count: u32,
        pub flags: u32,
    }

    const _: () = assert!(size_of::<AudioRingHeader>() as u64 <= BLOCKS_OFFSET);
    const _: () = assert!(size_of::<AudioBlockHeader>() as u64 <= BLOCK_SAMPLES_OFFSET);
    const _: () = assert!(BLOCKS_OFFSET.is_multiple_of(BLOCK_ALIGN));
    const _: () = assert!(BLOCK_SAMPLES_OFFSET.is_multiple_of(BLOCK_ALIGN));
}
