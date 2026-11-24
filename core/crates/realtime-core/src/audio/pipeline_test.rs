use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{AudioOpener, AudioSink, AudioStatus, Command, OpenError, Pipeline, SEARCH_INTERVAL};
use crate::audio::{AudioError, AudioFormat, AudioPacket, AudioSource};
use crate::protocol::{CaptureState, LatestAudio};
use crate::ring::{AudioWriteError, BlockMeta};

const FORMAT: AudioFormat = AudioFormat {
    sample_rate: 48_000,
    channels: 2,
};

struct ScriptedAudioSource {
    packets: VecDeque<Result<AudioPacket, AudioError>>,
}

impl AudioSource for ScriptedAudioSource {
    fn next_packet(
        &mut self,
        _timeout: Duration,
        packet: &mut AudioPacket,
    ) -> Result<bool, AudioError> {
        match self.packets.pop_front() {
            None => Ok(false),
            Some(Ok(next)) => {
                *packet = next;
                Ok(true)
            }
            Some(Err(error)) => Err(error),
        }
    }
}

struct ScriptedAudioOpener {
    opens: VecDeque<Result<Vec<Result<AudioPacket, AudioError>>, OpenError>>,
}

impl AudioOpener for ScriptedAudioOpener {
    fn open(&mut self, _format: AudioFormat) -> Result<Box<dyn AudioSource>, OpenError> {
        let packets = self
            .opens
            .pop_front()
            .unwrap_or(Err(OpenError::Audio(AudioError::ProcessExited)))?;
        Ok(Box::new(ScriptedAudioSource {
            packets: packets.into(),
        }))
    }
}

impl fmt::Display for ScriptedAudioOpener {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("scripted")
    }
}

struct RecordingAudioSink {
    next: u64,
    written: Arc<Mutex<Vec<(u64, bool)>>>,
}

impl AudioSink for RecordingAudioSink {
    fn format(&self) -> AudioFormat {
        FORMAT
    }

    fn write(&mut self, packet: &AudioPacket) -> Result<BlockMeta, AudioWriteError> {
        self.next += 1;
        self.written
            .lock()
            .unwrap()
            .push((self.next, packet.discontinuity));
        Ok(BlockMeta {
            block_number: self.next,
            capture_ns: packet.capture_ns,
            sample_count: packet.sample_count,
            flags: u32::from(packet.discontinuity),
        })
    }
}

#[test]
fn audio_pipeline_marks_first_block_discontinuous_and_searches_on_exit() {
    let status = Arc::new(AudioStatus::default());
    let written = Arc::new(Mutex::new(Vec::new()));
    let mut pipeline = Pipeline::new(Arc::clone(&status));
    let t0 = Instant::now();
    assert_eq!(pipeline.step(t0), None);
    pipeline.apply(Command::Attach(Box::new(RecordingAudioSink {
        next: 0,
        written: Arc::clone(&written),
    })));
    pipeline.apply(Command::Target(Box::new(ScriptedAudioOpener {
        opens: VecDeque::from([Ok(vec![
            Ok(AudioPacket {
                capture_ns: 500,
                sample_count: 10,
                data: vec![0; 80],
                discontinuity: false,
            }),
            Ok(AudioPacket {
                capture_ns: 700,
                sample_count: 10,
                data: vec![0; 80],
                discontinuity: false,
            }),
            Err(AudioError::ProcessExited),
        ])]),
    })));

    assert_eq!(pipeline.step(t0), Some(Duration::ZERO));
    assert_eq!(
        status.snapshot(),
        (
            CaptureState::Capturing,
            Some(LatestAudio {
                block_number: 1,
                capture_ns: 500,
            })
        )
    );
    assert_eq!(pipeline.step(t0), Some(Duration::ZERO));
    assert_eq!(pipeline.step(t0), Some(SEARCH_INTERVAL));
    assert_eq!(status.snapshot().0, CaptureState::Searching);
    assert_eq!(*written.lock().unwrap(), [(1, true), (2, false)]);
}
