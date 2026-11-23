import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMidiTempoFile } from './midiEncoder';

test('MIDI export creates a valid format-0 conductor track with loop markers', async () => {
  const blob = encodeMidiTempoFile('SYN MASTER Test', 10, 120, true);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'MThd');
  assert.equal(bytes[11], 1);
  const track = new TextDecoder().decode(bytes);
  assert.ok(track.includes('SYN MASTER tempo map only'));
  assert.ok(track.includes('Loop Start'));
  assert.ok(track.includes('Loop End'));
});

test('MIDI export clamps invalid tempo and never invents audio note events', async () => {
  const blob = encodeMidiTempoFile('SYN MASTER', 1, Number.NaN, false);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'MThd');
  assert.equal(bytes.includes(0x90), false);
  assert.equal(bytes.includes(0x80), false);
});
