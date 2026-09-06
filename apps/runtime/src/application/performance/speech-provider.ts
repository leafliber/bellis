import type { SpeechIntent } from "@bellis/contracts";

/** Pull-based PCM: 48kHz mono S16LE, exactly one 20ms frame per yield.
 * Implementations must stop network/compute work when the signal aborts.
 * Resolution of the iterator is generation completion, not playback confirmation.
 */
export interface SpeechProvider {
  stream(speech: SpeechIntent, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface PcmSpeechSource {
  frames(signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** Buffered input remains supported for existing integrations and fixtures. */
export interface BufferedPcmSpeech {
  readonly pcm: Uint8Array;
  readonly frameCount: number;
}
