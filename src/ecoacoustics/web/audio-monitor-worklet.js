/**
 * AudioWorklet processor for server-side mic monitoring.
 *
 * Receives Float32 audio chunks posted from the main thread (converted from
 * s16le PCM streamed by the server) and plays them through the AudioContext
 * destination.  A ring buffer absorbs network jitter; if it fills beyond the
 * target fill level, old samples are skipped to prevent ever-growing latency.
 *
 * Author: David Green, Blenheim Palace
 */

const RING_SIZE  = 24576;  // 512ms at 48kHz — absorbs bursts without growing forever
const TARGET_MS  = 120;    // aim to keep ~120ms of audio queued (latency vs dropout tradeoff)
const SAMPLE_RATE = 48000;
const TARGET_FILL = Math.round(TARGET_MS / 1000 * SAMPLE_RATE);  // ~5760 samples

class AudioMonitorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring  = new Float32Array(RING_SIZE);
    this._write = 0;
    this._read  = 0;
    this._fill  = 0;

    this.port.onmessage = ({ data }) => {
      // data is a Float32Array of mono samples converted by the main thread
      for (let i = 0; i < data.length; i++) {
        if (this._fill >= RING_SIZE) {
          // Buffer full — advance read pointer (discard oldest sample)
          this._read = (this._read + 1) % RING_SIZE;
          this._fill--;
        }
        this._ring[this._write] = data[i];
        this._write = (this._write + 1) % RING_SIZE;
        this._fill++;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];  // mono output channel
    if (!out) return true;

    for (let i = 0; i < out.length; i++) {
      if (this._fill > 0) {
        out[i] = this._ring[this._read];
        this._read = (this._read + 1) % RING_SIZE;
        this._fill--;
      } else {
        out[i] = 0;  // underrun — output silence
      }
    }
    return true;
  }
}

registerProcessor('audio-monitor-processor', AudioMonitorProcessor);
