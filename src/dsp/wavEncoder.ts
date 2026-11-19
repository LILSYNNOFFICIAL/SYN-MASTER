import type { ExportConfig } from '../types/mastering';
import { dbToLinear } from './analyzer';

/**
 * Resample a channel using bandlimited Blackman-windowed sinc interpolation
 * so high-frequency content above destination Nyquist is cleanly attenuated.
 */
export function resampleChannel(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);

  //Cutoff relative to input sample rate: 0.43 * min(fromRate, toRate) / fromRate
  const bwScale = toRate < fromRate ? Math.max(0.05, (0.86 * toRate) / fromRate) : 0.92;
  const halfWidth = 28; // 56-tap windowed sinc kernel

  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    const centerInt = Math.floor(center);
    const start = Math.max(0, centerInt - halfWidth);
    const end = Math.min(input.length - 1, centerInt + halfWidth);

    let sum = 0;
    let norm = 0;
    for (let j = start; j <= end; j++) {
      const dist = j - center;
      const arg = dist * bwScale;
      const sinc = Math.abs(arg) < 1e-8 ? 1.0 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      const u = (dist + halfWidth) / (2 * halfWidth);
      const win =
        u >= 0 && u <= 1
          ? 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u)
          : 0;
      const coeff = sinc * win * bwScale;
      sum += input[j] * coeff;
      norm += coeff;
    }
    out[i] = norm > 1e-9 ? sum / norm : input[Math.min(input.length - 1, centerInt)];
  }
  return out;
}

/**
 * Encode Float32Array channels into a standard RIFF WAVE Blob (16-bit PCM, 24-bit PCM, or 32-bit IEEE Float)
 * with optional Triangular Probability Density Function (TPDF) Dithering.
 */
export function encodeWavBlob(
  channels: Float32Array[],
  sourceSampleRate: number,
  config: ExportConfig,
): Blob {
  let processedChannels: Float32Array[] = channels.map((c) => new Float32Array(c));

  // Optional Mono fold-down
  if (config.channels === 'mono' && processedChannels.length > 1) {
    const len = processedChannels[0].length;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      mono[i] = 0.5 * (processedChannels[0][i] + processedChannels[1][i]);
    }
    processedChannels = [mono];
  }

  // Sample Rate Conversion if requested
  if (config.sampleRate !== sourceSampleRate) {
    processedChannels = processedChannels.map((ch) =>
      resampleChannel(ch, sourceSampleRate, config.sampleRate),
    );
  }

  // Final safety ceiling clamp
  const ceilLin = dbToLinear(config.ceilingDb);
  for (const ch of processedChannels) {
    for (let i = 0; i < ch.length; i++) {
      if (ch[i] > ceilLin) ch[i] = ceilLin;
      else if (ch[i] < -ceilLin) ch[i] = -ceilLin;
    }
  }

  const numChannels = processedChannels.length;
  const numFrames = processedChannels[0].length;
  const bytesPerSample = config.wavBitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = config.sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM/Float chunk size
  view.setUint16(20, config.wavBitDepth === 32 ? 3 : 1, true); // 3 = IEEE float, 1 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, config.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, config.wavBitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const useDither = config.dither === 'tpdf' && config.wavBitDepth < 32;
  let offset = 44;

  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = processedChannels[ch][i];
      if (config.wavBitDepth === 32) {
        view.setFloat32(offset, sample, true);
      } else if (config.wavBitDepth === 24) {
        const scale = 8388607;
        const dither = useDither ? (Math.random() - Math.random()) / scale : 0;
        sample = Math.max(-1, Math.min(1, sample + dither));
        const intVal = Math.round(sample * scale);
        view.setUint8(offset, intVal & 0xff);
        view.setUint8(offset + 1, (intVal >> 8) & 0xff);
        view.setUint8(offset + 2, (intVal >> 16) & 0xff);
      } else {
        // 16-bit PCM
        const scale = 32767;
        const dither = useDither ? (Math.random() - Math.random()) / scale : 0;
        sample = Math.max(-1, Math.min(1, sample + dither));
        view.setInt16(offset, Math.round(sample * scale), true);
      }
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
