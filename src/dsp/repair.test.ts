import test from 'node:test';
import assert from 'node:assert/strict';
import { detectClicks } from './clickDetect';
import { repairClicksChannel, repairEdgeClicksChannel, repairEdgeClicksStereo } from './repair';

const SR = 44100;

function tone(length = SR) {
  const ch = new Float32Array(length);
  for (let i = 0; i < length; i++) ch[i] = 0.18 * Math.sin((2 * Math.PI * 440 * i) / SR);
  return ch;
}

test('localized click repair removes an isolated AI-style impulse without fading the whole track', () => {
  const ch = tone();
  const clickAt = Math.floor(SR * 0.5);
  ch[clickAt] += 0.8;
  const before = detectClicks([ch], SR);
  assert.ok(before.clickCount > 0, 'the injected discontinuity should be detected');

  const repaired = repairClicksChannel(ch, SR, 8, 0.02, Math.round(SR * 0.0015));
  const after = detectClicks([ch], SR);
  assert.ok(repaired > 0, 'the isolated discontinuity should be reconstructed');
  assert.ok(after.clickCount < before.clickCount, 'post-repair analysis should confirm fewer clicks');
  assert.ok(Math.abs(ch[Math.floor(SR * 0.25)]) > 0.05, 'unaffected programme audio must remain intact');
  assert.ok(Math.abs(ch[Math.floor(SR * 0.75)]) > 0.05, 'the repair must remain local to the click window');
});

test('edge click repair uses a smooth fade-in rather than leaving a hard file-boundary step', () => {
  const ch = tone();
  ch[0] = 0.7;
  const repaired = repairEdgeClicksChannel(ch, SR, 8);
  assert.equal(repaired, 1);
  assert.equal(ch[0], 0);
  assert.ok(Math.abs(ch[Math.round(SR * 0.008)]) > 0, 'audio should have faded back in by the end of the microfade');
  assert.ok(Math.abs(ch[Math.round(SR * 0.008)]) < Math.abs(tone()[Math.round(SR * 0.008)]) + 0.02);
});

test('stereo edge repair applies the same fade envelope to both channels', () => {
  const left = tone();
  const right = tone().map((sample) => sample * 0.5);
  left[0] = 0.7;
  const repaired = repairEdgeClicksStereo(left, right, SR, 8);
  assert.equal(repaired, 1);
  assert.equal(left[0], 0);
  assert.equal(right[0], 0);
  const at = Math.round(SR * 0.004);
  assert.ok(Math.abs(left[at]) > 0 && Math.abs(right[at]) > 0);
  assert.ok(Math.abs(left[at] / right[at] - 2) < 0.05, 'the fade must preserve the stereo level relationship');
});
