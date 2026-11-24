//! 帧环的打开与 seqlock 写入方（读取方由 Python 侧提供；测试读取方在 `#[cfg(test)]` 下）。

use std::mem::offset_of;
use std::sync::atomic::{AtomicU64, Ordering, fence};

use crate::capture::{BYTES_PER_PIXEL, Frame, FrameMeta};
use crate::protocol::FrameRingAttachParams;
use crate::ring::error::{FrameRingError, FrameWriteError};
use crate::ring::layout::frame::{
    FrameRingHeader, FrameSlotHeader, LAYOUT_VERSION, MAGIC, PIXEL_FORMAT_BGRA8, SLOT_ALIGN,
    SLOT_PIXELS_OFFSET, SLOTS_OFFSET,
};
use crate::shm::SharedMemory;

const BYTES_PER_PIXEL_U64: u64 = 4;

#[allow(clippy::cast_possible_truncation, reason = "布局常量远小于 usize")]
const SLOTS_START: usize = SLOTS_OFFSET as usize;
#[allow(clippy::cast_possible_truncation, reason = "布局常量远小于 usize")]
const PIXELS_START: usize = SLOT_PIXELS_OFFSET as usize;

pub(crate) mod header {
    use super::{FrameRingHeader, offset_of};

    pub(crate) const MAGIC: usize = offset_of!(FrameRingHeader, magic);
    pub(crate) const LAYOUT_VERSION: usize = offset_of!(FrameRingHeader, layout_version);
    pub(crate) const SLOT_COUNT: usize = offset_of!(FrameRingHeader, slot_count);
    pub(crate) const SLOT_STRIDE: usize = offset_of!(FrameRingHeader, slot_stride);
    pub(crate) const MAX_WIDTH: usize = offset_of!(FrameRingHeader, max_width);
    pub(crate) const MAX_HEIGHT: usize = offset_of!(FrameRingHeader, max_height);
    pub(crate) const WRITE_SEQ: usize = offset_of!(FrameRingHeader, write_seq);
}

mod slot {
    use super::{FrameSlotHeader, offset_of};

    pub(super) const SEQ: usize = offset_of!(FrameSlotHeader, seq);
    pub(super) const FRAME_NUMBER: usize = offset_of!(FrameSlotHeader, frame_number);
    pub(super) const CAPTURE_NS: usize = offset_of!(FrameSlotHeader, capture_ns);
    pub(super) const TRANSFORM_VERSION: usize = offset_of!(FrameSlotHeader, transform_version);
    pub(super) const WIDTH: usize = offset_of!(FrameSlotHeader, width);
    pub(super) const HEIGHT: usize = offset_of!(FrameSlotHeader, height);
    pub(super) const ROW_STRIDE: usize = offset_of!(FrameSlotHeader, row_stride);
    pub(super) const PIXEL_FORMAT: usize = offset_of!(FrameSlotHeader, pixel_format);
}

/// 槽头部中 `seq` 之外的一帧元数据。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SlotMeta {
    pub frame_number: u64,
    pub capture_ns: u64,
    pub transform_version: u64,
    pub width: u32,
    pub height: u32,
    pub row_stride: u32,
}

#[derive(Debug)]
struct Ring {
    memory: SharedMemory,
    slot_count: u32,
    slot_stride: usize,
    max_width: u32,
    max_height: u32,
}

fn invalid(reason: impl Into<String>) -> FrameRingError {
    FrameRingError::InvalidParams(reason.into())
}

fn check_params(params: &FrameRingAttachParams) -> Result<(usize, usize), FrameRingError> {
    if params.name.is_empty() || params.name.contains('\0') {
        return Err(invalid("the name is empty or contains NUL"));
    }
    if params.layout_version != LAYOUT_VERSION {
        return Err(invalid(format!(
            "layout_version is {}, this implementation is {LAYOUT_VERSION}",
            params.layout_version
        )));
    }
    if params.slot_count < 2 {
        return Err(invalid("slot_count is less than 2"));
    }
    if params.max_width == 0 || params.max_height == 0 {
        return Err(invalid("max_width and max_height must be positive"));
    }
    if !params.slot_stride.is_multiple_of(SLOT_ALIGN) {
        return Err(invalid(format!(
            "slot_stride {} is not a multiple of {SLOT_ALIGN}",
            params.slot_stride
        )));
    }
    let largest_frame =
        u64::from(params.max_width) * u64::from(params.max_height) * BYTES_PER_PIXEL_U64;
    if params.slot_stride < SLOT_PIXELS_OFFSET + largest_frame {
        return Err(invalid(format!(
            "slot_stride {} cannot hold a {}x{} frame",
            params.slot_stride, params.max_width, params.max_height
        )));
    }
    let needed = u64::from(params.slot_count)
        .checked_mul(params.slot_stride)
        .and_then(|slots| slots.checked_add(SLOTS_OFFSET))
        .ok_or_else(|| invalid("the slots overflow u64"))?;
    if params.size_bytes < needed {
        return Err(invalid(format!(
            "size_bytes {} is less than the {needed} bytes the slots need",
            params.size_bytes
        )));
    }
    let size = usize::try_from(params.size_bytes)
        .map_err(|_| invalid("size_bytes does not fit in memory"))?;
    let slot_stride = usize::try_from(params.slot_stride)
        .map_err(|_| invalid("slot_stride does not fit in memory"))?;
    Ok((size, slot_stride))
}

impl Ring {
    fn open(params: &FrameRingAttachParams) -> Result<Self, FrameRingError> {
        let (size, slot_stride) = check_params(params)?;
        let memory =
            SharedMemory::open(&params.name, size).map_err(|source| FrameRingError::Open {
                name: params.name.clone(),
                source,
            })?;
        let ring = Self {
            memory,
            slot_count: params.slot_count,
            slot_stride,
            max_width: params.max_width,
            max_height: params.max_height,
        };
        ring.check_header(params)?;
        Ok(ring)
    }

    fn check_header(&self, params: &FrameRingAttachParams) -> Result<(), FrameRingError> {
        let m = &self.memory;
        let fields = [
            (
                "magic",
                m.u64_at(header::MAGIC).load(Ordering::Acquire),
                MAGIC,
            ),
            (
                "layout_version",
                u64::from(m.u32_at(header::LAYOUT_VERSION).load(Ordering::Relaxed)),
                u64::from(params.layout_version),
            ),
            (
                "slot_count",
                u64::from(m.u32_at(header::SLOT_COUNT).load(Ordering::Relaxed)),
                u64::from(params.slot_count),
            ),
            (
                "slot_stride",
                m.u64_at(header::SLOT_STRIDE).load(Ordering::Relaxed),
                params.slot_stride,
            ),
            (
                "max_width",
                u64::from(m.u32_at(header::MAX_WIDTH).load(Ordering::Relaxed)),
                u64::from(params.max_width),
            ),
            (
                "max_height",
                u64::from(m.u32_at(header::MAX_HEIGHT).load(Ordering::Relaxed)),
                u64::from(params.max_height),
            ),
        ];
        for (field, header, expected) in fields {
            if header != expected {
                return Err(FrameRingError::Mismatch {
                    field,
                    header,
                    expected,
                });
            }
        }
        Ok(())
    }

    fn write_seq(&self) -> &AtomicU64 {
        self.memory.u64_at(header::WRITE_SEQ)
    }

    fn slot_of(&self, frame_number: u64) -> u32 {
        u32::try_from((frame_number - 1) % u64::from(self.slot_count))
            .expect("remainder is less than slot_count")
    }

    fn slot_start(&self, slot: u32) -> usize {
        assert!(slot < self.slot_count, "slot {slot} out of range");
        SLOTS_START + slot as usize * self.slot_stride
    }

    fn slot_seq(&self, slot: u32) -> &AtomicU64 {
        self.memory.u64_at(self.slot_start(slot) + slot::SEQ)
    }

    fn store_meta(&self, slot: u32, meta: &SlotMeta) {
        let start = self.slot_start(slot);
        let m = &self.memory;
        let r = Ordering::Relaxed;
        m.u64_at(start + slot::FRAME_NUMBER)
            .store(meta.frame_number, r);
        m.u64_at(start + slot::CAPTURE_NS).store(meta.capture_ns, r);
        m.u64_at(start + slot::TRANSFORM_VERSION)
            .store(meta.transform_version, r);
        m.u32_at(start + slot::WIDTH).store(meta.width, r);
        m.u32_at(start + slot::HEIGHT).store(meta.height, r);
        m.u32_at(start + slot::ROW_STRIDE).store(meta.row_stride, r);
        m.u32_at(start + slot::PIXEL_FORMAT)
            .store(PIXEL_FORMAT_BGRA8, r);
    }

    fn store_pixels(&self, slot: u32, offset: usize, pixels: &[u8]) {
        assert!(offset + pixels.len() <= self.slot_stride - PIXELS_START);
        self.memory
            .store(self.slot_start(slot) + PIXELS_START + offset, pixels);
    }
}

/// 帧环的写入方：实时核按 seqlock 规则写槽并发布 `write_seq`。
#[derive(Debug)]
pub struct FrameRingWriter {
    ring: Ring,
    base: u64,
    last_number: u64,
    last_source_number: u64,
}

impl FrameRingWriter {
    /// 打开帧环并核对头部；帧号从头部的 `write_seq` 续写。
    ///
    /// # Errors
    ///
    /// 参数不合布局、打不开共享内存或头部字段不符时返回 [`FrameRingError`]。
    pub fn attach(params: &FrameRingAttachParams) -> Result<Self, FrameRingError> {
        let ring = Ring::open(params)?;
        let resumed = ring.write_seq().load(Ordering::Acquire);
        Ok(Self {
            ring,
            base: resumed,
            last_number: resumed,
            last_source_number: 0,
        })
    }

    pub fn resume_after(&mut self, previous_frame: u64) {
        self.base = self.base.max(previous_frame);
    }

    #[must_use]
    pub fn last_frame_number(&self) -> u64 {
        self.last_number
    }

    /// 写入一帧，返回它在帧环中的帧号。
    ///
    /// # Errors
    ///
    /// 见 [`Self::write_parts`]。
    pub fn write(&mut self, frame: &Frame) -> Result<u64, FrameWriteError> {
        self.write_parts(&frame.meta, &frame.pixels)
    }

    /// 写入元数据为 `meta`、像素为 `pixels` 的一帧，返回帧号。
    ///
    /// # Errors
    ///
    /// 帧比帧环大或帧本身不合规则时返回 [`FrameWriteError`]，帧环不受影响。
    pub fn write_parts(&mut self, meta: &FrameMeta, pixels: &[u8]) -> Result<u64, FrameWriteError> {
        let (row_bytes, row_stride) = self.check(meta, pixels)?;
        let (base, number) = self.next_number(meta.number)?;
        let ring = &self.ring;
        let slot = ring.slot_of(number);
        let seq = ring.slot_seq(slot);

        let previous = seq.load(Ordering::Relaxed);
        let odd = previous.wrapping_add(1 + (previous & 1));
        seq.store(odd, Ordering::Relaxed);
        fence(Ordering::Release);

        ring.store_meta(
            slot,
            &SlotMeta {
                frame_number: number,
                capture_ns: meta.captured_at_ns,
                transform_version: meta.transform_version,
                width: meta.width,
                height: meta.height,
                row_stride,
            },
        );
        let stride = meta.stride as usize;
        if stride == row_bytes {
            ring.store_pixels(slot, 0, &pixels[..row_bytes * meta.height as usize]);
        } else {
            for (y, row) in pixels.chunks(stride).take(meta.height as usize).enumerate() {
                ring.store_pixels(slot, y * row_bytes, &row[..row_bytes]);
            }
        }

        seq.store(odd.wrapping_add(1), Ordering::Release);
        ring.write_seq().store(number, Ordering::Release);
        self.base = base;
        self.last_number = number;
        self.last_source_number = meta.number;
        Ok(number)
    }

    fn check(&self, meta: &FrameMeta, pixels: &[u8]) -> Result<(usize, u32), FrameWriteError> {
        if meta.number == 0 {
            return Err(FrameWriteError::InvalidFrame("frame number is 0"));
        }
        if meta.width == 0 || meta.height == 0 {
            return Err(FrameWriteError::InvalidFrame("the frame is empty"));
        }
        if meta.width > self.ring.max_width || meta.height > self.ring.max_height {
            return Err(FrameWriteError::TooLarge {
                width: meta.width,
                height: meta.height,
                max_width: self.ring.max_width,
                max_height: self.ring.max_height,
            });
        }
        let row_stride = meta
            .width
            .checked_mul(BYTES_PER_PIXEL)
            .ok_or(FrameWriteError::InvalidFrame("width * 4 overflows u32"))?;
        if meta.stride < row_stride {
            return Err(FrameWriteError::InvalidFrame(
                "stride is less than width * 4",
            ));
        }
        let needed = u64::from(meta.stride) * u64::from(meta.height);
        if (pixels.len() as u64) < needed {
            return Err(FrameWriteError::InvalidFrame(
                "fewer pixels than stride * height",
            ));
        }
        Ok((row_stride as usize, row_stride))
    }

    fn next_number(&self, source_number: u64) -> Result<(u64, u64), FrameWriteError> {
        let base = if source_number <= self.last_source_number {
            self.last_number
        } else {
            self.base
        };
        let number = base
            .checked_add(source_number)
            .ok_or(FrameWriteError::InvalidFrame("frame number overflows u64"))?;
        Ok((base, number))
    }
}

#[cfg(test)]
pub(crate) use test_reader::{FrameReadOutcome, FrameRingReader, write_header};

#[cfg(test)]
mod test_reader {
    use std::hint::spin_loop;
    use std::sync::atomic::{Ordering, fence};

    use super::{
        BYTES_PER_PIXEL_U64, FrameRingAttachParams, FrameRingError, MAGIC, PIXEL_FORMAT_BGRA8,
        PIXELS_START, Ring, SharedMemory, SlotMeta, header, slot,
    };
    use crate::ring::error::FrameReadError;

    impl SlotMeta {
        pub(crate) fn pixel_bytes(&self) -> u64 {
            u64::from(self.row_stride) * u64::from(self.height)
        }
    }

    impl Ring {
        fn load_meta(&self, slot: u32) -> (SlotMeta, u32) {
            let start = self.slot_start(slot);
            let m = &self.memory;
            let r = Ordering::Relaxed;
            let meta = SlotMeta {
                frame_number: m.u64_at(start + slot::FRAME_NUMBER).load(r),
                capture_ns: m.u64_at(start + slot::CAPTURE_NS).load(r),
                transform_version: m.u64_at(start + slot::TRANSFORM_VERSION).load(r),
                width: m.u32_at(start + slot::WIDTH).load(r),
                height: m.u32_at(start + slot::HEIGHT).load(r),
                row_stride: m.u32_at(start + slot::ROW_STRIDE).load(r),
            };
            (meta, m.u32_at(start + slot::PIXEL_FORMAT).load(r))
        }

        fn check_meta(&self, meta: &SlotMeta, pixel_format: u32) -> Result<(), String> {
            if pixel_format != PIXEL_FORMAT_BGRA8 {
                return Err(format!("pixel_format is {pixel_format}"));
            }
            if meta.width > self.max_width || meta.height > self.max_height {
                return Err(format!(
                    "a {}x{} frame exceeds {}x{}",
                    meta.width, meta.height, self.max_width, self.max_height
                ));
            }
            if u64::from(meta.row_stride) < u64::from(meta.width) * BYTES_PER_PIXEL_U64 {
                return Err(format!(
                    "row_stride {} is less than width {} * 4",
                    meta.row_stride, meta.width
                ));
            }
            let capacity = (self.slot_stride - PIXELS_START) as u64;
            if meta.pixel_bytes() > capacity {
                return Err(format!(
                    "{} rows of {} bytes exceed the {capacity}-byte slot",
                    meta.height, meta.row_stride
                ));
            }
            Ok(())
        }

        fn load_pixels(&self, slot: u32, pixels: &mut [u8]) {
            assert!(pixels.len() <= self.slot_stride - PIXELS_START);
            self.memory
                .load(self.slot_start(slot) + PIXELS_START, pixels);
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum FrameReadOutcome {
        Empty,
        Frame(SlotMeta),
        Torn,
    }

    #[derive(Debug)]
    pub(crate) struct FrameRingReader {
        ring: Ring,
    }

    impl FrameRingReader {
        pub(crate) fn open(params: &FrameRingAttachParams) -> Result<Self, FrameRingError> {
            Ring::open(params).map(|ring| Self { ring })
        }

        pub(crate) fn latest_frame_number(&self) -> u64 {
            self.ring.write_seq().load(Ordering::Acquire)
        }

        pub(crate) fn read_latest(
            &self,
            pixels: &mut Vec<u8>,
            attempts: u32,
        ) -> Result<FrameReadOutcome, FrameReadError> {
            let ring = &self.ring;
            for _ in 0..attempts {
                let number = ring.write_seq().load(Ordering::Acquire);
                if number == 0 {
                    return Ok(FrameReadOutcome::Empty);
                }
                let slot = ring.slot_of(number);
                let seq = ring.slot_seq(slot);
                let before = seq.load(Ordering::Acquire);
                if before & 1 == 1 {
                    spin_loop();
                    continue;
                }
                let (meta, pixel_format) = ring.load_meta(slot);
                if meta.frame_number != number {
                    continue;
                }
                if let Err(reason) = ring.check_meta(&meta, pixel_format) {
                    fence(Ordering::Acquire);
                    if seq.load(Ordering::Relaxed) != before {
                        continue;
                    }
                    return Err(FrameReadError::Corrupt(reason));
                }
                #[allow(clippy::cast_possible_truncation, reason = "已核对不超过槽容量")]
                pixels.resize(meta.pixel_bytes() as usize, 0);
                ring.load_pixels(slot, pixels);
                fence(Ordering::Acquire);
                if seq.load(Ordering::Relaxed) == before {
                    return Ok(FrameReadOutcome::Frame(meta));
                }
            }
            Ok(FrameReadOutcome::Torn)
        }
    }

    pub(crate) fn write_header(memory: &SharedMemory, params: &FrameRingAttachParams) {
        let r = Ordering::Relaxed;
        memory
            .u32_at(header::LAYOUT_VERSION)
            .store(params.layout_version, r);
        memory
            .u32_at(header::SLOT_COUNT)
            .store(params.slot_count, r);
        memory
            .u64_at(header::SLOT_STRIDE)
            .store(params.slot_stride, r);
        memory.u32_at(header::MAX_WIDTH).store(params.max_width, r);
        memory
            .u32_at(header::MAX_HEIGHT)
            .store(params.max_height, r);
        memory.u64_at(header::WRITE_SEQ).store(0, r);
        memory.u64_at(header::MAGIC).store(MAGIC, Ordering::Release);
    }
}
