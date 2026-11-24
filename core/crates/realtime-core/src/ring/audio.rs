//! 音频环的打开与 seqlock 写入方（读取方由 Python 侧提供；测试读取方在 `#[cfg(test)]` 下）。

use std::mem::offset_of;
use std::sync::atomic::{AtomicU64, Ordering, fence};

use crate::audio::{AudioFormat, AudioPacket};
use crate::protocol::AudioRingAttachParams;
use crate::ring::error::{AudioRingError, AudioWriteError};
use crate::ring::layout::audio::{
    AudioBlockHeader, AudioRingHeader, BLOCK_ALIGN, BLOCK_SAMPLES_OFFSET, BLOCKS_OFFSET,
    BYTES_PER_VALUE, FLAG_DISCONTINUITY, LAYOUT_VERSION, MAGIC, MAX_CHANNELS, MAX_SAMPLE_RATE,
    MIN_SAMPLE_RATE, SAMPLE_FORMAT_F32,
};
use crate::shm::SharedMemory;

#[allow(clippy::cast_possible_truncation, reason = "布局常量远小于 usize")]
const BLOCKS_START: usize = BLOCKS_OFFSET as usize;
#[allow(clippy::cast_possible_truncation, reason = "布局常量远小于 usize")]
const SAMPLES_START: usize = BLOCK_SAMPLES_OFFSET as usize;

pub(crate) mod header {
    use super::{AudioRingHeader, offset_of};

    pub(crate) const MAGIC: usize = offset_of!(AudioRingHeader, magic);
    pub(crate) const LAYOUT_VERSION: usize = offset_of!(AudioRingHeader, layout_version);
    pub(crate) const BLOCK_COUNT: usize = offset_of!(AudioRingHeader, block_count);
    pub(crate) const BLOCK_STRIDE: usize = offset_of!(AudioRingHeader, block_stride);
    pub(crate) const BLOCK_CAPACITY: usize = offset_of!(AudioRingHeader, block_capacity);
    pub(crate) const SAMPLE_RATE: usize = offset_of!(AudioRingHeader, sample_rate);
    pub(crate) const CHANNELS: usize = offset_of!(AudioRingHeader, channels);
    pub(crate) const SAMPLE_FORMAT: usize = offset_of!(AudioRingHeader, sample_format);
    pub(crate) const WRITE_SEQ: usize = offset_of!(AudioRingHeader, write_seq);
}

mod block {
    use super::{AudioBlockHeader, offset_of};

    pub(super) const SEQ: usize = offset_of!(AudioBlockHeader, seq);
    pub(super) const BLOCK_NUMBER: usize = offset_of!(AudioBlockHeader, block_number);
    pub(super) const CAPTURE_NS: usize = offset_of!(AudioBlockHeader, capture_ns);
    pub(super) const SAMPLE_COUNT: usize = offset_of!(AudioBlockHeader, sample_count);
    pub(super) const FLAGS: usize = offset_of!(AudioBlockHeader, flags);
}

/// 音频块头部中 `seq` 之外的字段。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlockMeta {
    pub block_number: u64,
    pub capture_ns: u64,
    pub sample_count: u32,
    pub flags: u32,
}

#[derive(Debug)]
struct Ring {
    memory: SharedMemory,
    block_count: u32,
    block_stride: usize,
    block_capacity: u32,
    format: AudioFormat,
}

fn invalid(reason: impl Into<String>) -> AudioRingError {
    AudioRingError::InvalidParams(reason.into())
}

fn block_bytes(params: &AudioRingAttachParams) -> u64 {
    u64::from(params.block_capacity) * u64::from(params.channels) * u64::from(BYTES_PER_VALUE)
}

fn check_params(params: &AudioRingAttachParams) -> Result<(usize, usize), AudioRingError> {
    if params.name.is_empty() || params.name.contains('\0') {
        return Err(invalid("the name is empty or contains NUL"));
    }
    if params.layout_version != LAYOUT_VERSION {
        return Err(invalid(format!(
            "layout_version is {}, this implementation is {LAYOUT_VERSION}",
            params.layout_version
        )));
    }
    if params.block_count < 2 {
        return Err(invalid("block_count is less than 2"));
    }
    if params.sample_format != SAMPLE_FORMAT_F32 {
        return Err(invalid(format!(
            "sample_format {} is not F32",
            params.sample_format
        )));
    }
    if !(1..=MAX_CHANNELS).contains(&params.channels) {
        return Err(invalid(format!(
            "{} channels; 1 to {MAX_CHANNELS} are supported",
            params.channels
        )));
    }
    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&params.sample_rate) {
        return Err(invalid(format!(
            "a sample rate of {} Hz is outside {MIN_SAMPLE_RATE} to {MAX_SAMPLE_RATE}",
            params.sample_rate
        )));
    }
    if params.block_capacity == 0 {
        return Err(invalid("block_capacity is 0"));
    }
    if !params.block_stride.is_multiple_of(BLOCK_ALIGN) {
        return Err(invalid(format!(
            "block_stride {} is not a multiple of {BLOCK_ALIGN}",
            params.block_stride
        )));
    }
    if params.block_stride < BLOCK_SAMPLES_OFFSET + block_bytes(params) {
        return Err(invalid(format!(
            "block_stride {} cannot hold {} samples of {} channel(s)",
            params.block_stride, params.block_capacity, params.channels
        )));
    }
    let needed = u64::from(params.block_count)
        .checked_mul(params.block_stride)
        .and_then(|blocks| blocks.checked_add(BLOCKS_OFFSET))
        .ok_or_else(|| invalid("the blocks overflow u64"))?;
    if params.size_bytes < needed {
        return Err(invalid(format!(
            "size_bytes {} is less than the {needed} bytes the blocks need",
            params.size_bytes
        )));
    }
    let size = usize::try_from(params.size_bytes)
        .map_err(|_| invalid("size_bytes does not fit in memory"))?;
    let block_stride = usize::try_from(params.block_stride)
        .map_err(|_| invalid("block_stride does not fit in memory"))?;
    Ok((size, block_stride))
}

impl Ring {
    fn open(params: &AudioRingAttachParams) -> Result<Self, AudioRingError> {
        let (size, block_stride) = check_params(params)?;
        let memory =
            SharedMemory::open(&params.name, size).map_err(|source| AudioRingError::Open {
                name: params.name.clone(),
                source,
            })?;
        let ring = Self {
            memory,
            block_count: params.block_count,
            block_stride,
            block_capacity: params.block_capacity,
            format: AudioFormat {
                sample_rate: params.sample_rate,
                channels: params.channels,
            },
        };
        ring.check_header(params)?;
        Ok(ring)
    }

    fn check_header(&self, params: &AudioRingAttachParams) -> Result<(), AudioRingError> {
        let m = &self.memory;
        let u32_field = |offset| u64::from(m.u32_at(offset).load(Ordering::Relaxed));
        let fields = [
            (
                "magic",
                m.u64_at(header::MAGIC).load(Ordering::Acquire),
                MAGIC,
            ),
            (
                "layout_version",
                u32_field(header::LAYOUT_VERSION),
                u64::from(params.layout_version),
            ),
            (
                "block_count",
                u32_field(header::BLOCK_COUNT),
                u64::from(params.block_count),
            ),
            (
                "block_stride",
                m.u64_at(header::BLOCK_STRIDE).load(Ordering::Relaxed),
                params.block_stride,
            ),
            (
                "block_capacity",
                u32_field(header::BLOCK_CAPACITY),
                u64::from(params.block_capacity),
            ),
            (
                "sample_rate",
                u32_field(header::SAMPLE_RATE),
                u64::from(params.sample_rate),
            ),
            (
                "channels",
                u32_field(header::CHANNELS),
                u64::from(params.channels),
            ),
            (
                "sample_format",
                u32_field(header::SAMPLE_FORMAT),
                u64::from(params.sample_format),
            ),
        ];
        for (field, header, expected) in fields {
            if header != expected {
                return Err(AudioRingError::Mismatch {
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

    fn slot_of(&self, block_number: u64) -> u32 {
        u32::try_from((block_number - 1) % u64::from(self.block_count))
            .expect("remainder is less than block_count")
    }

    fn slot_start(&self, slot: u32) -> usize {
        assert!(slot < self.block_count, "slot {slot} out of range");
        BLOCKS_START + slot as usize * self.block_stride
    }

    fn block_seq(&self, slot: u32) -> &AtomicU64 {
        self.memory.u64_at(self.slot_start(slot) + block::SEQ)
    }

    fn store_meta(&self, slot: u32, meta: &BlockMeta) {
        let start = self.slot_start(slot);
        let m = &self.memory;
        let r = Ordering::Relaxed;
        m.u64_at(start + block::BLOCK_NUMBER)
            .store(meta.block_number, r);
        m.u64_at(start + block::CAPTURE_NS)
            .store(meta.capture_ns, r);
        m.u32_at(start + block::SAMPLE_COUNT)
            .store(meta.sample_count, r);
        m.u32_at(start + block::FLAGS).store(meta.flags, r);
    }

    fn sample_bytes(&self, sample_count: u32) -> usize {
        sample_count as usize * self.format.bytes_per_sample()
    }

    fn store_samples(&self, slot: u32, samples: &[u8]) {
        assert!(samples.len() <= self.block_stride - SAMPLES_START);
        self.memory
            .store(self.slot_start(slot) + SAMPLES_START, samples);
    }
}

/// 音频环的写入方：实时核按 seqlock 规则写块并发布 `write_seq`。
#[derive(Debug)]
pub struct AudioRingWriter {
    ring: Ring,
    last_number: u64,
}

impl AudioRingWriter {
    /// 打开音频环并核对头部；块号从头部的 `write_seq` 续写。
    ///
    /// # Errors
    ///
    /// 见 [`AudioRingError`]。
    pub fn attach(params: &AudioRingAttachParams) -> Result<Self, AudioRingError> {
        let ring = Ring::open(params)?;
        let resumed = ring.write_seq().load(Ordering::Acquire);
        Ok(Self {
            ring,
            last_number: resumed,
        })
    }

    #[must_use]
    pub fn format(&self) -> AudioFormat {
        self.ring.format
    }

    #[must_use]
    pub fn last_block_number(&self) -> u64 {
        self.last_number
    }

    /// 写入一个音频包，超容量时拆成连续多块，返回写出的最后一块元数据。
    ///
    /// # Errors
    ///
    /// 见 [`AudioWriteError`]。
    pub fn write(&mut self, packet: &AudioPacket) -> Result<BlockMeta, AudioWriteError> {
        let format = self.ring.format;
        if packet.sample_count == 0 {
            return Err(AudioWriteError::InvalidPacket(
                "the packet has no samples".into(),
            ));
        }
        let expected = self.ring.sample_bytes(packet.sample_count);
        if packet.data.len() != expected {
            return Err(AudioWriteError::InvalidPacket(format!(
                "{} bytes for {} samples of {format}, expected {expected}",
                packet.data.len(),
                packet.sample_count
            )));
        }
        let blocks = packet.sample_count.div_ceil(self.ring.block_capacity);
        self.last_number
            .checked_add(u64::from(blocks))
            .ok_or_else(|| AudioWriteError::InvalidPacket("block numbers overflow u64".into()))?;

        let capacity = self.ring.block_capacity;
        let mut offset = 0u32;
        let mut last = BlockMeta::default();
        while offset < packet.sample_count {
            let count = capacity.min(packet.sample_count - offset);
            let flags = if offset == 0 && packet.discontinuity {
                FLAG_DISCONTINUITY
            } else {
                0
            };
            let meta = BlockMeta {
                block_number: self.last_number + 1,
                capture_ns: packet
                    .capture_ns
                    .saturating_add(format.duration_ns(u64::from(offset))),
                sample_count: count,
                flags,
            };
            let start = self.ring.sample_bytes(offset);
            let end = start + self.ring.sample_bytes(count);
            self.write_block(&meta, &packet.data[start..end]);
            self.last_number = meta.block_number;
            last = meta;
            offset += count;
        }
        Ok(last)
    }

    fn write_block(&self, meta: &BlockMeta, samples: &[u8]) {
        let ring = &self.ring;
        let slot = ring.slot_of(meta.block_number);
        let seq = ring.block_seq(slot);
        let previous = seq.load(Ordering::Relaxed);
        let odd = previous.wrapping_add(1 + (previous & 1));
        seq.store(odd, Ordering::Relaxed);
        fence(Ordering::Release);
        ring.store_meta(slot, meta);
        ring.store_samples(slot, samples);
        seq.store(odd.wrapping_add(1), Ordering::Release);
        ring.write_seq().store(meta.block_number, Ordering::Release);
    }
}

#[cfg(test)]
pub(crate) use test_reader::{AudioRingReader, BlockRead, write_header};

#[cfg(test)]
mod test_reader {
    use std::sync::atomic::{Ordering, fence};

    use super::{
        AudioRingAttachParams, AudioRingError, BlockMeta, MAGIC, Ring, SAMPLES_START, SharedMemory,
        block, header,
    };
    use crate::ring::error::AudioReadError;
    use crate::ring::layout::audio::KNOWN_FLAGS;

    impl Ring {
        fn load_meta(&self, slot: u32) -> BlockMeta {
            let start = self.slot_start(slot);
            let m = &self.memory;
            let r = Ordering::Relaxed;
            BlockMeta {
                block_number: m.u64_at(start + block::BLOCK_NUMBER).load(r),
                capture_ns: m.u64_at(start + block::CAPTURE_NS).load(r),
                sample_count: m.u32_at(start + block::SAMPLE_COUNT).load(r),
                flags: m.u32_at(start + block::FLAGS).load(r),
            }
        }

        fn check_meta(&self, meta: &BlockMeta) -> Result<(), String> {
            if meta.sample_count == 0 || meta.sample_count > self.block_capacity {
                return Err(format!(
                    "{} samples, the capacity is {}",
                    meta.sample_count, self.block_capacity
                ));
            }
            if meta.flags & !KNOWN_FLAGS != 0 {
                return Err(format!("unknown flags 0x{:X}", meta.flags));
            }
            Ok(())
        }

        fn load_samples(&self, slot: u32, samples: &mut [u8]) {
            assert!(samples.len() <= self.block_stride - SAMPLES_START);
            self.memory
                .load(self.slot_start(slot) + SAMPLES_START, samples);
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum BlockRead {
        Block(BlockMeta),
        Missing,
        Torn,
    }

    #[derive(Debug)]
    pub(crate) struct AudioRingReader {
        ring: Ring,
    }

    impl AudioRingReader {
        pub(crate) fn open(params: &AudioRingAttachParams) -> Result<Self, AudioRingError> {
            Ring::open(params).map(|ring| Self { ring })
        }

        pub(crate) fn read_block(
            &self,
            number: u64,
            samples: &mut Vec<u8>,
        ) -> Result<BlockRead, AudioReadError> {
            assert!(number > 0, "block numbers start at 1");
            let ring = &self.ring;
            let slot = ring.slot_of(number);
            let seq = ring.block_seq(slot);
            let before = seq.load(Ordering::Acquire);
            if before & 1 == 1 {
                return Ok(BlockRead::Torn);
            }
            let meta = ring.load_meta(slot);
            if meta.block_number != number {
                return Ok(BlockRead::Missing);
            }
            if let Err(reason) = ring.check_meta(&meta) {
                fence(Ordering::Acquire);
                if seq.load(Ordering::Relaxed) != before {
                    return Ok(BlockRead::Torn);
                }
                return Err(AudioReadError::Corrupt(reason));
            }
            samples.resize(ring.sample_bytes(meta.sample_count), 0);
            ring.load_samples(slot, samples);
            fence(Ordering::Acquire);
            if seq.load(Ordering::Relaxed) == before {
                Ok(BlockRead::Block(meta))
            } else {
                Ok(BlockRead::Torn)
            }
        }
    }

    pub(crate) fn write_header(memory: &SharedMemory, params: &AudioRingAttachParams) {
        let r = Ordering::Relaxed;
        memory
            .u32_at(header::LAYOUT_VERSION)
            .store(params.layout_version, r);
        memory
            .u32_at(header::BLOCK_COUNT)
            .store(params.block_count, r);
        memory
            .u64_at(header::BLOCK_STRIDE)
            .store(params.block_stride, r);
        memory
            .u32_at(header::BLOCK_CAPACITY)
            .store(params.block_capacity, r);
        memory
            .u32_at(header::SAMPLE_RATE)
            .store(params.sample_rate, r);
        memory.u32_at(header::CHANNELS).store(params.channels, r);
        memory
            .u32_at(header::SAMPLE_FORMAT)
            .store(params.sample_format, r);
        memory.u64_at(header::WRITE_SEQ).store(0, r);
        memory.u64_at(header::MAGIC).store(MAGIC, Ordering::Release);
    }
}
