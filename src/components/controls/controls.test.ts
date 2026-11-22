import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampNumber,
  computeDragValue,
  computeKeyStepValue,
  describeArcPath,
  formatParameterValue,
  inferExternalVst3ControlSpec,
  normalizedToAngleDeg,
  normalizedToValue,
  parseNumericEntry,
  quantizeToStep,
  valueToNormalized,
} from './parameterMath';
import type { ExternalPluginParamValue } from '../../types/mastering';

test('Controls Math: Clamping, min/max bounds, and floating-point-safe step quantization', () => {
  assert.equal(clampNumber(-50, -12, 12), -12);
  assert.equal(clampNumber(99, -12, 12), 12);
  assert.equal(clampNumber(Number.NaN, -12, 12, 0), 0);

  assert.equal(quantizeToStep(0.3000000004, -12, 12, 0.1), 0.3);
  assert.equal(quantizeToStep(3.74, 0, 10, 0.5), 3.5);
  assert.equal(quantizeToStep(3.76, 0, 10, 0.5), 4.0);
});

test('Controls Math: Linear and logarithmic normalization roundtrips', () => {
  // Linear bipolar range (-12 to +12 dB)
  assert.equal(valueToNormalized(0, -12, 12, 'linear'), 0.5);
  assert.equal(normalizedToValue(0.5, -12, 12, 'linear', 0.1), 0);
  assert.equal(normalizedToValue(0, -12, 12, 'linear', 0.1), -12);
  assert.equal(normalizedToValue(1, -12, 12, 'linear', 0.1), 12);

  // Logarithmic frequency range (20 Hz to 20,000 Hz): midpoint is geometric mean ~632.45 Hz
  const logMid = normalizedToValue(0.5, 20, 20000, 'logarithmic', 1);
  assert.ok(Math.abs(logMid - 632) <= 2, `Expected geometric midpoint ~632 Hz, got ${logMid}`);
  const backNorm = valueToNormalized(632.4555, 20, 20000, 'logarithmic');
  assert.ok(Math.abs(backNorm - 0.5) < 0.001, `Expected normalized 0.5, got ${backNorm}`);

  // Logarithmic time range (10 ms to 500 ms)
  const msMid = normalizedToValue(0.5, 10, 500, 'logarithmic', 1);
  assert.ok(Math.abs(msMid - Math.sqrt(10 * 500)) <= 1.5);
});

test('Controls Math: Vertical drag & Shift fine adjustment scaling', () => {
  const normal = computeDragValue({
    startNormalized: 0.5,
    deltaPx: 30,
    sensitivityPx: 150,
    fine: false,
    min: -12,
    max: 12,
    scale: 'linear',
    step: 0.1,
  });
  // +30px / 150px = +0.2 normalized -> 0.7 of [-12..12] = +4.8 dB
  assert.equal(normal.value, 4.8);

  const fine = computeDragValue({
    startNormalized: 0.5,
    deltaPx: 30,
    sensitivityPx: 150,
    fine: true,
    min: -12,
    max: 12,
    scale: 'linear',
    step: 0.1,
  });
  // Fine mode reduces sensitivity by 5x -> +0.04 normalized -> +1.0 dB
  assert.equal(fine.value, 1.0);

  // Clamping at boundaries
  const overMax = computeDragValue({
    startNormalized: 0.9,
    deltaPx: 400,
    sensitivityPx: 150,
    min: 0,
    max: 100,
    step: 1,
  });
  assert.equal(overMax.value, 100);
});

test('Controls Math: Keyboard arrow, Shift+arrow fine, Home/End, and reset behavior', () => {
  assert.equal(
    computeKeyStepValue({
      currentValue: 0,
      key: 'ArrowUp',
      min: -12,
      max: 12,
      step: 0.5,
    }),
    0.5,
  );
  assert.equal(
    computeKeyStepValue({
      currentValue: 0,
      key: 'ArrowLeft',
      min: -12,
      max: 12,
      step: 0.5,
    }),
    -0.5,
  );
  assert.equal(
    computeKeyStepValue({
      currentValue: 0,
      key: 'ArrowRight',
      shiftKey: true,
      min: -12,
      max: 12,
      step: 0.5,
    }),
    0.1,
  );
  assert.equal(
    computeKeyStepValue({
      currentValue: 4.5,
      key: 'Home',
      min: -12,
      max: 12,
      step: 0.5,
    }),
    -12,
  );
  assert.equal(
    computeKeyStepValue({
      currentValue: 4.5,
      key: 'End',
      min: -12,
      max: 12,
      step: 0.5,
    }),
    12,
  );
  assert.equal(
    computeKeyStepValue({
      currentValue: 7.5,
      key: 'Delete',
      min: -12,
      max: 12,
      step: 0.5,
      defaultValue: 0,
    }),
    0,
  );

  // Logarithmic keyboard step advances cleanly without sticking on low frequencies
  const nextFreq = computeKeyStepValue({
    currentValue: 100,
    key: 'ArrowUp',
    min: 20,
    max: 18000,
    scale: 'logarithmic',
    step: 1,
  });
  assert.ok(nextFreq !== null && nextFreq > 100);
});

test('Controls Formatting & Parsing: Hz/kHz, dB signed, ms/s, ratio, %, and arc angles', () => {
  assert.equal(formatParameterValue(320, { unit: 'Hz', step: 1 }), '320 Hz');
  assert.equal(formatParameterValue(2800, { unit: 'Hz', step: 1 }), '2.80 kHz');
  assert.equal(formatParameterValue(11500, { unit: 'Hz', step: 1 }), '11.5 kHz');
  assert.equal(formatParameterValue(1.5, { unit: 'dB', step: 0.1, signed: true }), '+1.5 dB');
  assert.equal(formatParameterValue(-3.5, { unit: 'dB', step: 0.1, signed: true }), '-3.5 dB');
  assert.equal(formatParameterValue(2.2, { unit: ':1', step: 0.1 }), '2.2:1');
  assert.equal(formatParameterValue(85, { unit: '%', step: 1, precision: 0 }), '85%');
  assert.equal(formatParameterValue(140, { unit: 'ms', step: 5 }), '140 ms');

  // Parse human typed values including unit suffixes
  assert.equal(parseNumericEntry('2.8 kHz', 20, 18000, 1, 'Hz'), 2800);
  assert.equal(parseNumericEntry('99999', -12, 12, 0.1, 'dB'), 12);
  assert.equal(parseNumericEntry('invalid', -12, 12, 0.1, 'dB'), null);

  // Arc sweep geometry (-135 to +135 degrees)
  assert.equal(normalizedToAngleDeg(0), -135);
  assert.equal(normalizedToAngleDeg(0.5), 0);
  assert.equal(normalizedToAngleDeg(1), 135);
  const arc = describeArcPath(26, 26, 20, -135, 135);
  assert.ok(arc.startsWith('M ') && arc.includes(' A '));
});

test('External VST3 Metadata Inference: maps Hz, dB, ms, switch, and read-only params', () => {
  const gainParam: ExternalPluginParamValue = {
    id: 0,
    name: 'Output Gain',
    label: 'dB',
    valueNormalized: 0.625,
    defaultValueNormalized: 0.5,
    stepCount: 0,
    isAutomatable: true,
    isReadOnly: false,
    isBypass: false,
    displayValue: '+6.0 dB',
  };
  const gainSpec = inferExternalVst3ControlSpec(gainParam);
  assert.equal(gainSpec.kind, 'knob');
  assert.equal(gainSpec.unit, 'dB');
  assert.equal(gainSpec.bipolar, true);
  assert.equal(gainSpec.formatValue(0.625), '+6.0 dB');

  const freqParam: ExternalPluginParamValue = {
    id: 1,
    name: 'Tilt Frequency',
    label: 'Hz',
    valueNormalized: 0.5,
    defaultValueNormalized: 0.5,
    stepCount: 0,
    isAutomatable: true,
    isReadOnly: false,
    isBypass: false,
    displayValue: '1.00 kHz',
  };
  const freqSpec = inferExternalVst3ControlSpec(freqParam);
  assert.equal(freqSpec.kind, 'knob');
  assert.equal(freqSpec.scale, 'logarithmic');
  assert.equal(freqSpec.formatValue(0.5), '1.00 kHz');

  const switchParam: ExternalPluginParamValue = {
    id: 2,
    name: 'Mono Check',
    label: '',
    valueNormalized: 1,
    defaultValueNormalized: 0,
    stepCount: 1,
    isAutomatable: true,
    isReadOnly: false,
    isBypass: false,
    displayValue: 'ON',
  };
  const switchSpec = inferExternalVst3ControlSpec(switchParam);
  assert.equal(switchSpec.kind, 'toggle');

  const meterReadOnlyParam: ExternalPluginParamValue = {
    id: 3,
    name: 'Gain Reduction Meter',
    label: 'dB',
    valueNormalized: 0.25,
    defaultValueNormalized: 0,
    stepCount: 0,
    isAutomatable: false,
    isReadOnly: true,
    isBypass: false,
    displayValue: '-3.2 dB',
  };
  assert.equal(meterReadOnlyParam.isReadOnly, true);
  assert.equal(inferExternalVst3ControlSpec(meterReadOnlyParam).formatValue(0.25), '-3.2 dB');
});

test('Controls Edge Cases: zero-span ranges, PageUp/PageDown/Backspace, rapid drag stability & normalized VST3 numeric entry', () => {
  // Zero-span parameter range cannot divide by zero or produce NaN
  assert.equal(valueToNormalized(5, 5, 5, 'linear'), 0);
  assert.equal(normalizedToValue(0.5, 5, 5, 'linear', 0.1), 5);
  assert.equal(computeKeyStepValue({ currentValue: 5, key: 'ArrowUp', min: 5, max: 5 }), 5);

  // Negative & zero crossing quantization (no -0 or IEEE-754 drift)
  const zeroSnap = quantizeToStep(-0.04, -12, 12, 0.1);
  assert.equal(Object.is(zeroSnap, 0), true);
  assert.equal(formatParameterValue(-0.001, { unit: 'dB', step: 0.1, signed: true }), '0.0 dB');

  // PageUp/PageDown (10x step) and Backspace reset
  assert.equal(
    computeKeyStepValue({ currentValue: 0, key: 'PageUp', min: -12, max: 12, step: 0.5 }),
    5,
  );
  assert.equal(
    computeKeyStepValue({ currentValue: 0, key: 'PageDown', min: -12, max: 12, step: 0.5 }),
    -5,
  );
  assert.equal(
    computeKeyStepValue({ currentValue: 6.5, key: 'Backspace', min: -12, max: 12, step: 0.5, defaultValue: 0 }),
    0,
  );

  // Rapid multi-frame drag progression remains clamped and finite
  let norm = valueToNormalized(0, -18, 0, 'linear');
  for (let i = 0; i < 60; i++) {
    const step = computeDragValue({
      startNormalized: norm,
      deltaPx: -8,
      sensitivityPx: 145,
      min: -18,
      max: 0,
      step: 0.1,
    });
    assert.ok(Number.isFinite(step.value) && step.value >= -18 && step.value <= 0);
    norm = step.normalized;
  }
  assert.equal(computeDragValue({ startNormalized: norm, deltaPx: -200, min: -18, max: 0, step: 0.1 }).value, -18);

  // Normalized VST3 inline entry parses 0..1 and % without kHz/s *1000 clamping bug
  assert.equal(parseNumericEntry('0.75', 0, 1, 0.005, 'Hz', 0, true), 0.75);
  assert.equal(parseNumericEntry('50%', 0, 1, 0.005, 'Hz', 0, true), 0.5);
  assert.equal(parseNumericEntry('1.5 s', 10, 5000, 5, 'ms'), 1500);
});

test('External VST3 QA Plugin Parity: SYN Test Gain and Tilt QA APVTS parameters map cleanly', () => {
  const qaParams: ExternalPluginParamValue[] = [
    { id: 0, name: 'Gain', label: 'dB', valueNormalized: 0.5, defaultValueNormalized: 0.5, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false, displayValue: '0.0 dB' },
    { id: 1, name: 'High Tilt', label: 'dB', valueNormalized: 0.5, defaultValueNormalized: 0.5, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false, displayValue: '0.0 dB' },
    { id: 2, name: 'Stereo Width', label: '%', valueNormalized: 0.5, defaultValueNormalized: 0.5, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false, displayValue: '100%' },
    { id: 3, name: 'Bypass', label: '', valueNormalized: 0.0, defaultValueNormalized: 0.0, stepCount: 1, isAutomatable: true, isReadOnly: false, isBypass: true, displayValue: 'Off' },
  ];

  const gainSpec = inferExternalVst3ControlSpec(qaParams[0]);
  assert.equal(gainSpec.kind, 'knob');
  assert.equal(gainSpec.bipolar, true);
  assert.equal(gainSpec.unit, 'dB');

  const tiltSpec = inferExternalVst3ControlSpec(qaParams[1]);
  assert.equal(tiltSpec.kind, 'knob');
  assert.equal(tiltSpec.bipolar, true);

  const widthSpec = inferExternalVst3ControlSpec(qaParams[2]);
  assert.equal(widthSpec.kind, 'knob');
  assert.equal(widthSpec.unit, '%');
  assert.equal(widthSpec.formatValue(0.5), '100%');

  const bypassSpec = inferExternalVst3ControlSpec(qaParams[3]);
  assert.equal(bypassSpec.kind, 'toggle');
});

