/**
 * SYN MASTER MIDI metadata exporter.
 * Imported audio cannot be converted into MIDI notes. This emits a standards-compliant
 * tempo/conductor track with a title and optional full-song loop markers only.
 */
const encoder = new TextEncoder();

function variableLength(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}

function metaEvent(type: number, text: string): number[] {
  const data = Array.from(encoder.encode(text));
  return [0xff, type, ...variableLength(data.length), ...data];
}

function writeU32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function encodeMidiTempoFile(
  title: string,
  durationSec: number,
  tempoBpm = 120,
  includeLoopMarkers = true,
): Blob {
  const safeTempo = Number.isFinite(tempoBpm) ? Math.max(20, Math.min(300, tempoBpm)) : 120;
  const safeDuration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const microsPerQuarter = Math.round(60_000_000 / safeTempo);
  const ppq = 480;
  const endTick = Math.max(1, Math.round(safeDuration * safeTempo * (ppq / 60)));
  const tempo = [0xff, 0x51, 0x03, (microsPerQuarter >>> 16) & 0xff, (microsPerQuarter >>> 8) & 0xff, microsPerQuarter & 0xff];
  const events: Array<{ tick: number; order: number; bytes: number[] }> = [
    { tick: 0, order: 0, bytes: metaEvent(0x03, title.slice(0, 120) || 'SYN MASTER') },
    { tick: 0, order: 1, bytes: tempo },
    { tick: 0, order: 2, bytes: metaEvent(0x06, 'SYN MASTER tempo map only - no audio or note events') },
  ];
  if (includeLoopMarkers) {
    events.push({ tick: 0, order: 3, bytes: metaEvent(0x06, 'Loop Start') });
    events.push({ tick: endTick, order: 0, bytes: metaEvent(0x06, 'Loop End') });
  }
  events.push({ tick: endTick, order: 9, bytes: [0xff, 0x2f, 0x00] });
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  let previousTick = 0;
  for (const event of events) {
    track.push(...variableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  const header = [0x4d, 0x54, 0x68, 0x64, ...writeU32(6), 0, 0, 0, 1, (ppq >>> 8) & 0xff, ppq & 0xff];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, ...writeU32(track.length)];
  return new Blob([new Uint8Array([...header, ...trackHeader, ...track])], { type: 'audio/midi' });
}
