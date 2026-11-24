export interface WaveformOverlayPoint {
  x: number;
  top: number;
  bottom: number;
}

/**
 * Maps an audio peak envelope into a centered, width-bounded waveform overlay.
 * Values are normalized amplitudes; invalid samples are treated as silence.
 */
export function buildWaveformOverlayPoints(
  peaks: readonly number[],
  width: number,
  centerY: number,
  amplitude: number,
): WaveformOverlayPoint[] {
  if (peaks.length === 0 || !Number.isFinite(width) || width <= 0 || !Number.isFinite(centerY) || !Number.isFinite(amplitude) || amplitude < 0) {
    return [];
  }

  const pointCount = Math.min(peaks.length, Math.max(2, Math.floor(width)));
  const denominator = Math.max(1, pointCount - 1);
  const sourceDenominator = Math.max(1, peaks.length - 1);

  return Array.from({ length: pointCount }, (_, index) => {
    const sourceIndex = Math.round((index / denominator) * sourceDenominator);
    const raw = peaks[sourceIndex];
    const magnitude = Number.isFinite(raw) ? Math.max(0, Math.min(1, Math.abs(raw))) : 0;
    const halfHeight = magnitude * amplitude;
    return {
      x: (index / denominator) * width,
      top: centerY - halfHeight,
      bottom: centerY + halfHeight,
    };
  });
}
