//! 帧环、音频环与 `tests/fixtures/realtime_core/ring_layout.json` 偏移表双向核对测试。

use std::mem::{align_of, offset_of, size_of};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use crate::audio::AudioPacket;
use crate::capture::{Frame, FrameMeta};
use crate::protocol::{AudioRingAttachParams, FrameRingAttachParams};
use crate::ring::audio::{self, AudioRingReader, AudioRingWriter, BlockRead};
use crate::ring::frame::{self, FrameReadOutcome, FrameRingReader, FrameRingWriter};
use crate::ring::layout::audio::{
    self as audio_layout, AudioBlockHeader, AudioRingHeader, FLAG_DISCONTINUITY,
};
use crate::ring::layout::frame::{self as frame_layout, FrameRingHeader, FrameSlotHeader};
use crate::shm::{SharedMemory, test_util::Created};

fn fixture_layout() -> Value {
    let text = include_str!("../../../../../tests/fixtures/realtime_core/ring_layout.json");
    serde_json::from_str(text).expect("ring_layout.json 是合法 JSON")
}

struct ExpectedField {
    name: &'static str,
    offset: usize,
    size: usize,
    ty: &'static str,
}

fn assert_struct_matches(
    section: &Value,
    struct_name: &str,
    actual_size: usize,
    actual_align: usize,
    expected_fields: &[ExpectedField],
) {
    let spec = &section["structs"][struct_name];
    assert_eq!(
        spec["size"].as_u64(),
        Some(actual_size as u64),
        "{struct_name}.size"
    );
    assert_eq!(
        spec["align"].as_u64(),
        Some(actual_align as u64),
        "{struct_name}.align"
    );
    let fields = spec["fields"].as_array().expect("fields array");
    assert_eq!(
        fields.len(),
        expected_fields.len(),
        "{struct_name} field count"
    );
    let mut end = 0;
    for (fixture_field, rust_field) in fields.iter().zip(expected_fields) {
        assert_eq!(fixture_field["name"].as_str(), Some(rust_field.name));
        assert_eq!(
            fixture_field["offset"].as_u64(),
            Some(rust_field.offset as u64),
            "{struct_name}.{} offset",
            rust_field.name
        );
        assert_eq!(
            fixture_field["size"].as_u64(),
            Some(rust_field.size as u64),
            "{struct_name}.{} size",
            rust_field.name
        );
        assert_eq!(
            fixture_field["type"].as_str(),
            Some(rust_field.ty),
            "{struct_name}.{} type",
            rust_field.name
        );
        assert_eq!(rust_field.offset, end, "{struct_name} has implicit padding");
        assert_eq!(rust_field.offset % rust_field.size, 0);
        end += rust_field.size;
    }
    assert_eq!(end, actual_size, "{struct_name} has trailing padding");
    assert_eq!(actual_align, 8);
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "逐字段核对 4 个 repr(C) 头部全部偏移与常量"
)]
fn ring_layout_fixture_matches_rust_repr_c_byte_for_byte() {
    let layout = fixture_layout();

    let fc = &layout["frame_ring"]["constants"];
    assert_eq!(&frame_layout::MAGIC.to_le_bytes(), b"BGRTRING");
    assert_eq!(fc["MAGIC"].as_u64(), Some(frame_layout::MAGIC));
    assert_eq!(fc["MAGIC_ASCII"].as_str(), Some("BGRTRING"));
    assert_eq!(
        fc["LAYOUT_VERSION"].as_u64(),
        Some(u64::from(frame_layout::LAYOUT_VERSION))
    );
    assert_eq!(
        fc["SLOTS_OFFSET"].as_u64(),
        Some(frame_layout::SLOTS_OFFSET)
    );
    assert_eq!(
        fc["SLOT_PIXELS_OFFSET"].as_u64(),
        Some(frame_layout::SLOT_PIXELS_OFFSET)
    );
    assert_eq!(fc["SLOT_ALIGN"].as_u64(), Some(frame_layout::SLOT_ALIGN));
    assert_eq!(
        fc["PIXEL_FORMAT_BGRA8"].as_u64(),
        Some(u64::from(frame_layout::PIXEL_FORMAT_BGRA8))
    );

    assert_struct_matches(
        &layout["frame_ring"],
        "FrameRingHeader",
        size_of::<FrameRingHeader>(),
        align_of::<FrameRingHeader>(),
        &[
            ExpectedField {
                name: "magic",
                offset: offset_of!(FrameRingHeader, magic),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "layout_version",
                offset: offset_of!(FrameRingHeader, layout_version),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "slot_count",
                offset: offset_of!(FrameRingHeader, slot_count),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "slot_stride",
                offset: offset_of!(FrameRingHeader, slot_stride),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "max_width",
                offset: offset_of!(FrameRingHeader, max_width),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "max_height",
                offset: offset_of!(FrameRingHeader, max_height),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "write_seq",
                offset: offset_of!(FrameRingHeader, write_seq),
                size: size_of::<AtomicU64>(),
                ty: "atomic_u64",
            },
        ],
    );

    assert_struct_matches(
        &layout["frame_ring"],
        "FrameSlotHeader",
        size_of::<FrameSlotHeader>(),
        align_of::<FrameSlotHeader>(),
        &[
            ExpectedField {
                name: "seq",
                offset: offset_of!(FrameSlotHeader, seq),
                size: size_of::<AtomicU64>(),
                ty: "atomic_u64",
            },
            ExpectedField {
                name: "frame_number",
                offset: offset_of!(FrameSlotHeader, frame_number),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "capture_ns",
                offset: offset_of!(FrameSlotHeader, capture_ns),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "transform_version",
                offset: offset_of!(FrameSlotHeader, transform_version),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "width",
                offset: offset_of!(FrameSlotHeader, width),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "height",
                offset: offset_of!(FrameSlotHeader, height),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "row_stride",
                offset: offset_of!(FrameSlotHeader, row_stride),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "pixel_format",
                offset: offset_of!(FrameSlotHeader, pixel_format),
                size: size_of::<u32>(),
                ty: "u32",
            },
        ],
    );

    let ac = &layout["audio_ring"]["constants"];
    assert_eq!(&audio_layout::MAGIC.to_le_bytes(), b"BGRAUDIO");
    assert_eq!(ac["MAGIC"].as_u64(), Some(audio_layout::MAGIC));
    assert_eq!(ac["MAGIC_ASCII"].as_str(), Some("BGRAUDIO"));
    assert_eq!(
        ac["LAYOUT_VERSION"].as_u64(),
        Some(u64::from(audio_layout::LAYOUT_VERSION))
    );
    assert_eq!(
        ac["BLOCKS_OFFSET"].as_u64(),
        Some(audio_layout::BLOCKS_OFFSET)
    );
    assert_eq!(
        ac["BLOCK_SAMPLES_OFFSET"].as_u64(),
        Some(audio_layout::BLOCK_SAMPLES_OFFSET)
    );
    assert_eq!(ac["BLOCK_ALIGN"].as_u64(), Some(audio_layout::BLOCK_ALIGN));
    assert_eq!(
        ac["SAMPLE_FORMAT_F32"].as_u64(),
        Some(u64::from(audio_layout::SAMPLE_FORMAT_F32))
    );
    assert_eq!(
        ac["BYTES_PER_VALUE"].as_u64(),
        Some(u64::from(audio_layout::BYTES_PER_VALUE))
    );
    assert_eq!(
        ac["MAX_CHANNELS"].as_u64(),
        Some(u64::from(audio_layout::MAX_CHANNELS))
    );
    assert_eq!(
        ac["MIN_SAMPLE_RATE"].as_u64(),
        Some(u64::from(audio_layout::MIN_SAMPLE_RATE))
    );
    assert_eq!(
        ac["MAX_SAMPLE_RATE"].as_u64(),
        Some(u64::from(audio_layout::MAX_SAMPLE_RATE))
    );
    assert_eq!(
        ac["FLAG_DISCONTINUITY"].as_u64(),
        Some(u64::from(FLAG_DISCONTINUITY))
    );
    assert_eq!(
        ac["KNOWN_FLAGS"].as_u64(),
        Some(u64::from(audio_layout::KNOWN_FLAGS))
    );

    assert_struct_matches(
        &layout["audio_ring"],
        "AudioRingHeader",
        size_of::<AudioRingHeader>(),
        align_of::<AudioRingHeader>(),
        &[
            ExpectedField {
                name: "magic",
                offset: offset_of!(AudioRingHeader, magic),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "layout_version",
                offset: offset_of!(AudioRingHeader, layout_version),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "block_count",
                offset: offset_of!(AudioRingHeader, block_count),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "block_stride",
                offset: offset_of!(AudioRingHeader, block_stride),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "block_capacity",
                offset: offset_of!(AudioRingHeader, block_capacity),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "sample_rate",
                offset: offset_of!(AudioRingHeader, sample_rate),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "channels",
                offset: offset_of!(AudioRingHeader, channels),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "sample_format",
                offset: offset_of!(AudioRingHeader, sample_format),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "write_seq",
                offset: offset_of!(AudioRingHeader, write_seq),
                size: size_of::<AtomicU64>(),
                ty: "atomic_u64",
            },
        ],
    );

    assert_struct_matches(
        &layout["audio_ring"],
        "AudioBlockHeader",
        size_of::<AudioBlockHeader>(),
        align_of::<AudioBlockHeader>(),
        &[
            ExpectedField {
                name: "seq",
                offset: offset_of!(AudioBlockHeader, seq),
                size: size_of::<AtomicU64>(),
                ty: "atomic_u64",
            },
            ExpectedField {
                name: "block_number",
                offset: offset_of!(AudioBlockHeader, block_number),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "capture_ns",
                offset: offset_of!(AudioBlockHeader, capture_ns),
                size: size_of::<u64>(),
                ty: "u64",
            },
            ExpectedField {
                name: "sample_count",
                offset: offset_of!(AudioBlockHeader, sample_count),
                size: size_of::<u32>(),
                ty: "u32",
            },
            ExpectedField {
                name: "flags",
                offset: offset_of!(AudioBlockHeader, flags),
                size: size_of::<u32>(),
                ty: "u32",
            },
        ],
    );
}

fn unique_shm_name(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("Local\\bellis-test-{prefix}-{}-{n}", std::process::id())
}

#[test]
fn frame_ring_roundtrip_strips_stride_padding_and_resumes_seq() {
    let slot_stride = 128u64;
    let params = FrameRingAttachParams {
        name: unique_shm_name("frame"),
        size_bytes: 64 + 3 * slot_stride,
        layout_version: frame_layout::LAYOUT_VERSION,
        slot_count: 3,
        slot_stride,
        max_width: 4,
        max_height: 4,
    };
    let _created = Created::new(&params.name, usize::try_from(params.size_bytes).unwrap()).unwrap();
    let shm =
        SharedMemory::open(&params.name, usize::try_from(params.size_bytes).unwrap()).unwrap();
    frame::write_header(&shm, &params);

    let mut writer = FrameRingWriter::attach(&params).unwrap();
    let reader = FrameRingReader::open(&params).unwrap();
    let mut pixels = Vec::new();
    assert_eq!(
        reader.read_latest(&mut pixels, 4).unwrap(),
        FrameReadOutcome::Empty
    );

    // 2x2 帧带 4 字节行尾填充，写入后应去掉填充。
    let input = Frame {
        meta: FrameMeta {
            number: 1,
            captured_at_ns: 9_000,
            transform_version: 2,
            width: 2,
            height: 2,
            stride: 12,
            ..FrameMeta::default()
        },
        pixels: vec![
            1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99, // row 0 + pad
            9, 10, 11, 12, 13, 14, 15, 16, 88, 88, 88, 88, // row 1 + pad
        ],
    };
    assert_eq!(writer.write(&input).unwrap(), 1);
    let FrameReadOutcome::Frame(meta) = reader.read_latest(&mut pixels, 4).unwrap() else {
        panic!("expected frame");
    };
    assert_eq!(meta.frame_number, 1);
    assert_eq!(meta.capture_ns, 9_000);
    assert_eq!(meta.transform_version, 2);
    assert_eq!(meta.row_stride, 8);
    assert_eq!(pixels, (1..=16u8).collect::<Vec<_>>());

    // 重新挂接后从 write_seq 续写，不回退。
    let mut writer2 = FrameRingWriter::attach(&params).unwrap();
    assert_eq!(writer2.last_frame_number(), 1);
    assert_eq!(writer2.write(&input).unwrap(), 2);
    assert_eq!(reader.latest_frame_number(), 2);
}

#[test]
fn audio_ring_roundtrip_splits_packets_and_sets_discontinuity_on_first_block() {
    let block_stride = 128u64;
    let params = AudioRingAttachParams {
        name: unique_shm_name("audio"),
        size_bytes: 64 + 4 * block_stride,
        layout_version: audio_layout::LAYOUT_VERSION,
        block_count: 4,
        block_stride,
        block_capacity: 4,
        sample_rate: 48_000,
        channels: 2,
        sample_format: audio_layout::SAMPLE_FORMAT_F32,
    };
    let _created = Created::new(&params.name, usize::try_from(params.size_bytes).unwrap()).unwrap();
    let shm =
        SharedMemory::open(&params.name, usize::try_from(params.size_bytes).unwrap()).unwrap();
    audio::write_header(&shm, &params);

    let mut writer = AudioRingWriter::attach(&params).unwrap();
    let reader = AudioRingReader::open(&params).unwrap();
    // 6 个采样点（每点 8 字节）超过容量 4，应拆成 4 + 2 两块。
    let packet = AudioPacket {
        capture_ns: 1_000_000,
        sample_count: 6,
        data: (0..48u8).collect(),
        discontinuity: true,
    };
    let last = writer.write(&packet).unwrap();
    assert_eq!(last.block_number, 2);
    assert_eq!(last.sample_count, 2);
    assert_eq!(last.flags, 0);

    let mut samples = Vec::new();
    let BlockRead::Block(b1) = reader.read_block(1, &mut samples).unwrap() else {
        panic!("expected block 1");
    };
    assert_eq!(b1.sample_count, 4);
    assert_eq!(b1.flags, FLAG_DISCONTINUITY);
    assert_eq!(b1.capture_ns, 1_000_000);
    assert_eq!(samples, (0..32u8).collect::<Vec<_>>());

    let BlockRead::Block(b2) = reader.read_block(2, &mut samples).unwrap() else {
        panic!("expected block 2");
    };
    assert_eq!(b2.sample_count, 2);
    assert_eq!(b2.flags, 0);
    assert_eq!(b2.capture_ns, 1_000_000 + writer.format().duration_ns(4));
    assert_eq!(samples, (32..48u8).collect::<Vec<_>>());
}
