/**
 * SYN-EQ band design: every parametric / dynamic EQ curve as a cascade of biquad sections.
 *
 * One function (`designBandSections`) is used by the offline renderer (preview, Fix All,
 * export), the realtime Web Audio graph (IIRFilterNode per section) and the drawn curve, so
 * what is drawn is exactly what is rendered.
 *
 * Legacy compatibility: a band with no `subtype` / `slope` renders with the original RBJ
 * designs (bell, analog shelf with Q as shelf slope S, 12 dB/oct pass with Q, notch), so
 * chains saved before subtypes existed render bit-identically.
 */
import type {
  DynamicEQBandType,
  EQBand,
  EQBandShape,
  EQBandSubtype,
  EQChannel,
  EQSlope,
  ParametricEQParams,
  ProcessorModule,
} from '../types/mastering';
import {
  type BiquadCoeffs,
  designBandPass,
  designHighPass,
  designHighShelf,
  designLowPass,
  designLowShelf,
  designNotch,
  designPeakingEQ,
  evaluateBiquadMagnitudeDb,
} from './biquad.ts';

export const IDENTITY: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
const SQRT1_2 = Math.SQRT1_2;

/** Subtypes offered for each family, in menu order. */
export const EQ_SUBTYPES: Record<EQBandShape, EQBandSubtype[]> = {
  bell: ['proportional', 'bell', 'band-shelf'],
  lowshelf: ['analog', 'baxandall', 'vintage', 'resonant'],
  highshelf: ['analog', 'baxandall', 'vintage', 'resonant'],
  lowpass: ['flat', 'resonant', 'brickwall'],
  highpass: ['flat', 'resonant', 'brickwall'],
  notch: [],
  bandpass: [],
  tilt: [],
};

/** The family default, which is the pre-subtype (legacy) curve. */
export const DEFAULT_SUBTYPE: Record<EQBandShape, EQBandSubtype | null> = {
  bell: 'bell',
  lowshelf: 'analog',
  highshelf: 'analog',
  lowpass: 'flat',
  highpass: 'flat',
  notch: null,
  bandpass: null,
  tilt: null,
};

export const ALL_SLOPES: EQSlope[] = [6, 12, 18, 24, 36, 48, 72, 96];

export const SHAPE_LABELS: Record<EQBandShape, string> = {
  bell: 'Bell',
  lowshelf: 'Low Shelf',
  highshelf: 'High Shelf',
  lowpass: 'Low-Pass',
  highpass: 'High-Pass',
  notch: 'Notch',
  bandpass: 'Band-Pass',
  tilt: 'Tilt',
};

export const SUBTYPE_LABELS: Record<EQBandSubtype, string> = {
  proportional: 'Proportional Q',
  bell: 'Bell',
  'band-shelf': 'Band Shelf',
  analog: 'Analog',
  baxandall: 'Baxandall',
  vintage: 'Vintage',
  resonant: 'Resonant',
  flat: 'Flat',
  brickwall: 'Brickwall',
};

export const CHANNEL_LABELS: Record<EQChannel, string> = {
  stereo: 'Stereo',
  mid: 'Mid',
  side: 'Side',
  left: 'Left',
  right: 'Right',
};

export const EQ_CHANNELS: EQChannel[] = ['stereo', 'mid', 'side', 'left', 'right'];

export function resolveSubtype(band: Pick<EQBand, 'shape' | 'subtype'>): EQBandSubtype | null {
  const allowed = EQ_SUBTYPES[band.shape] ?? [];
  if (band.subtype && allowed.includes(band.subtype)) return band.subtype;
  return DEFAULT_SUBTYPE[band.shape] ?? null;
}

/** Slopes a family/subtype supports. Empty = fixed slope (no selector). */
export function allowedSlopes(shape: EQBandShape, subtype: EQBandSubtype | null): EQSlope[] {
  if (shape === 'highpass' || shape === 'lowpass') {
    if (subtype === 'brickwall') return [];
    if (subtype === 'resonant') return [12, 18, 24, 36, 48, 72, 96];
    return ALL_SLOPES;
  }
  if (shape === 'lowshelf' || shape === 'highshelf') {
    if (subtype === 'analog') return [6, 12, 24];
    if (subtype === 'resonant') return [12, 24];
    return [];
  }
  return [];
}

export function resolveSlope(band: Pick<EQBand, 'shape' | 'subtype' | 'slope'>): EQSlope {
  const allowed = allowedSlopes(band.shape, resolveSubtype(band));
  if (band.slope !== undefined && allowed.includes(band.slope)) return band.slope;
  return 12;
}

export function usesGain(shape: EQBandShape): boolean {
  return shape === 'bell' || shape === 'lowshelf' || shape === 'highshelf' || shape === 'tilt';
}

/** Effective channel of a band: explicit `channel`, else the module's global M/S mode. */
export function bandChannel(band: Pick<EQBand, 'channel'>, msMode: ParametricEQParams['msMode']): EQChannel {
  if (band.channel) return band.channel;
  return msMode === 'mid-side' ? 'mid' : 'stereo';
}

/** True when the band uses only fields that existed before subtypes (legacy render path). */
export function isLegacyBand(band: EQBand): boolean {
  return (
    band.subtype === undefined &&
    band.slope === undefined &&
    band.channel === undefined &&
    !band.solo &&
    (band.shape === 'bell' ||
      band.shape === 'lowshelf' ||
      band.shape === 'highshelf' ||
      band.shape === 'highpass' ||
      band.shape === 'lowpass' ||
      band.shape === 'notch')
  );
}

/** True when the whole EQ can use the original render path unchanged. */
export function isLegacyEq(params: ParametricEQParams): boolean {
  return !params.autoGain && params.bands.every(isLegacyBand);
}

// ---------------------------------------------------------------------------
// Primitive designs (bilinear transform with frequency pre-warping)
// ---------------------------------------------------------------------------

function clampFreq(freq: number, sampleRate: number): number {
  return Math.max(10, Math.min(freq, sampleRate * 0.49));
}

function prewarpK(freq: number, sampleRate: number): number {
  return Math.tan((Math.PI * clampFreq(freq, sampleRate)) / sampleRate);
}

export function designFirstOrderLowPass(freq: number, sampleRate: number): BiquadCoeffs {
  const K = prewarpK(freq, sampleRate);
  const b0 = K / (1 + K);
  return { b0, b1: b0, b2: 0, a1: (K - 1) / (K + 1), a2: 0 };
}

export function designFirstOrderHighPass(freq: number, sampleRate: number): BiquadCoeffs {
  const K = prewarpK(freq, sampleRate);
  const b0 = 1 / (1 + K);
  return { b0, b1: -b0, b2: 0, a1: (K - 1) / (K + 1), a2: 0 };
}

/**
 * First-order shelf; `freq` is the geometric centre (half-gain point in dB).
 * Low: H(s) = (s + A) / (s + 1/A) (DC gain A^2 = gain), high: H(s) = A^2 (s + 1/A) / (s + A).
 */
export function designFirstOrderShelf(kind: 'low' | 'high', freq: number, gainDb: number, sampleRate: number): BiquadCoeffs {
  if (Math.abs(gainDb) < 1e-4) return { ...IDENTITY };
  const A = Math.pow(10, gainDb / 40);
  const K = prewarpK(freq, sampleRate);
  const invK = 1 / K;
  let n0: number;
  let n1: number;
  let d0: number;
  let d1: number;
  if (kind === 'low') {
    n0 = invK + A;
    n1 = A - invK;
    d0 = invK + 1 / A;
    d1 = 1 / A - invK;
  } else {
    const A2 = A * A;
    n0 = A2 * (invK + 1 / A);
    n1 = A2 * (1 / A - invK);
    d0 = invK + A;
    d1 = A - invK;
  }
  return { b0: n0 / d0, b1: n1 / d0, b2: 0, a1: d1 / d0, a2: 0 };
}

/** RBJ shelf in its Q form (alpha = sin w0 / 2Q). Q > 0.707 overshoots: the "resonant" shelf. */
export function designShelfQ(kind: 'low' | 'high', freq: number, gainDb: number, q: number, sampleRate: number): BiquadCoeffs {
  if (Math.abs(gainDb) < 1e-4) return { ...IDENTITY };
  const f = clampFreq(freq, sampleRate);
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const t = 2 * Math.sqrt(A) * alpha;
  if (kind === 'low') {
    const a0 = A + 1 + (A - 1) * cosw + t;
    return {
      b0: (A * (A + 1 - (A - 1) * cosw + t)) / a0,
      b1: (2 * A * (A - 1 - (A + 1) * cosw)) / a0,
      b2: (A * (A + 1 - (A - 1) * cosw - t)) / a0,
      a1: (-2 * (A - 1 + (A + 1) * cosw)) / a0,
      a2: (A + 1 + (A - 1) * cosw - t) / a0,
    };
  }
  const a0 = A + 1 - (A - 1) * cosw + t;
  return {
    b0: (A * (A + 1 + (A - 1) * cosw + t)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cosw)) / a0,
    b2: (A * (A + 1 + (A - 1) * cosw - t)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cosw)) / a0,
    a2: (A + 1 - (A - 1) * cosw - t) / a0,
  };
}

/** Butterworth section Qs for an order-N filter, highest Q first; `odd` = a 1st-order section is needed. */
export function butterworthQs(order: number): { qs: number[]; odd: boolean } {
  const qs: number[] = [];
  const pairs = Math.floor(order / 2);
  for (let k = 0; k < pairs; k++) {
    qs.push(-1 / (2 * Math.cos((Math.PI * (2 * k + order + 1)) / (2 * order))));
  }
  qs.sort((a, b) => b - a);
  return { qs, odd: order % 2 === 1 };
}

export const BRICKWALL_ORDER = 12;
export const BRICKWALL_RIPPLE_DB = 0.1;

/** Chebyshev type-I prototype poles as (normalised frequency, Q) pairs. */
export function chebyshevSections(order: number, rippleDb: number): Array<{ w: number; q: number }> {
  const eps = Math.sqrt(Math.pow(10, rippleDb / 10) - 1);
  const v = Math.asinh(1 / eps) / order;
  const out: Array<{ w: number; q: number }> = [];
  for (let k = 0; k < Math.floor(order / 2); k++) {
    const theta = (Math.PI * (2 * k + 1)) / (2 * order);
    const re = Math.sinh(v) * Math.sin(theta);
    const im = Math.cosh(v) * Math.cos(theta);
    const w = Math.hypot(re, im);
    out.push({ w, q: w / (2 * re) });
  }
  return out;
}

function slopeToOrder(slope: EQSlope): number {
  return Math.max(1, Math.round(slope / 6));
}

function designPass(
  kind: 'low' | 'high',
  subtype: EQBandSubtype,
  slope: EQSlope,
  freq: number,
  q: number,
  sampleRate: number,
): BiquadCoeffs[] {
  const second = kind === 'low' ? designLowPass : designHighPass;
  const first = kind === 'low' ? designFirstOrderLowPass : designFirstOrderHighPass;
  if (subtype === 'brickwall') {
    // Bilinear transform of the whole prototype, pre-warped once at the cutoff: each
    // section's digital frequency is chosen so its own RBJ pre-warp lands on w * K.
    const K = prewarpK(freq, sampleRate);
    return chebyshevSections(BRICKWALL_ORDER, BRICKWALL_RIPPLE_DB).map(({ w, q: sq }) => {
      const warped = kind === 'low' ? w * K : K / w;
      const fk = (sampleRate / Math.PI) * Math.atan(warped);
      return second(fk, sq, sampleRate);
    });
  }
  const order = slopeToOrder(slope);
  // Legacy: a 12 dB/oct flat pass is exactly the original RBJ 2nd-order with the band's Q.
  if (subtype === 'flat' && order === 2) return [second(freq, q, sampleRate)];
  const { qs, odd } = butterworthQs(order);
  const sections: BiquadCoeffs[] = [];
  qs.forEach((bq, idx) => {
    let sq = bq;
    if (idx === 0) {
      if (subtype === 'resonant') {
        // Resonant: the top section peaks (~+6 dB at the default Q of 0.71), more with higher Q.
        sq = Math.max(bq * 1.25, bq * 2.83 * (Math.max(0.25, q) / SQRT1_2));
      } else {
        // Flat: Q only reshapes the knee (0.71 = pure Butterworth).
        sq = bq * (Math.max(0.25, q) / SQRT1_2);
      }
    }
    sections.push(second(freq, sq, sampleRate));
  });
  if (odd) sections.push(first(freq, sampleRate));
  return sections;
}

/** Plateau half-width (as a frequency ratio) of a band shelf from its Q: wider than a bell's -3 dB edges. */
export function bandShelfRatio(q: number): number {
  const bwOct = (2 / Math.LN2) * Math.asinh(1 / (2 * Math.max(0.1, q)));
  return Math.pow(2, bwOct / 2 + 0.6);
}

const BAND_SHELF_Q = 0.9;

function bandShelfPair(freq: number, gainDb: number, k: number, sampleRate: number): BiquadCoeffs[] {
  return [
    designShelfQ('high', freq / k, gainDb, BAND_SHELF_Q, sampleRate),
    designShelfQ('high', freq * k, -gainDb, BAND_SHELF_Q, sampleRate),
  ];
}

/** Flat-top band: a rising and a falling shelf, with the inner gain solved so the plateau centre is exactly `gainDb`. */
export function designBandShelf(freq: number, gainDb: number, q: number, sampleRate: number): BiquadCoeffs[] {
  if (Math.abs(gainDb) < 1e-4) return [{ ...IDENTITY }];
  const k = bandShelfRatio(q);
  let g = gainDb;
  for (let it = 0; it < 4; it++) {
    const at = sectionsMagnitudeDb(bandShelfPair(freq, g, k, sampleRate), freq, sampleRate);
    if (Math.abs(at) < 1e-6) break;
    g *= gainDb / at;
    g = Math.max(-3 * Math.abs(gainDb), Math.min(3 * Math.abs(gainDb), g));
  }
  return bandShelfPair(freq, g, k, sampleRate);
}

/** Proportional-Q: Q follows gain (x1 at 6 dB, x2 at 18 dB, x0.71 near 0 dB). */
export function proportionalQ(q: number, gainDb: number): number {
  return q * Math.pow(10, (Math.abs(gainDb) - 6) / 40);
}

function designBellFamily(subtype: EQBandSubtype, freq: number, gainDb: number, q: number, sampleRate: number): BiquadCoeffs[] {
  if (subtype === 'proportional') return [designPeakingEQ(freq, gainDb, proportionalQ(q, gainDb), sampleRate)];
  if (subtype === 'band-shelf') return designBandShelf(freq, gainDb, q, sampleRate);
  return [designPeakingEQ(freq, gainDb, q, sampleRate)];
}

function designShelfFamily(
  kind: 'low' | 'high',
  subtype: EQBandSubtype,
  slope: EQSlope,
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoeffs[] {
  const rbj = kind === 'low' ? designLowShelf : designHighShelf;
  switch (subtype) {
    case 'baxandall': {
      // Two half-gain first-order shelves two octaves apart: the broad, still-rising
      // tone-control curve of a Baxandall bass/treble stage.
      const other = kind === 'low' ? freq / 4 : freq * 4;
      return [
        designFirstOrderShelf(kind, freq, gainDb / 2, sampleRate),
        designFirstOrderShelf(kind, other, gainDb / 2, sampleRate),
      ];
    }
    case 'vintage': {
      // Pultec-style: the shelf plus an opposite-polarity dip just past the corner.
      const dipF = kind === 'low' ? freq * 2.2 : freq / 2.2;
      return [rbj(freq, gainDb, q, sampleRate), designPeakingEQ(dipF, -0.35 * gainDb, 0.9, sampleRate)];
    }
    case 'resonant': {
      const rq = Math.max(1.0, 1.4 * (Math.max(0.2, q) / 0.71));
      if (slope === 24) {
        return [designShelfQ(kind, freq, gainDb / 2, rq, sampleRate), designShelfQ(kind, freq, gainDb / 2, rq, sampleRate)];
      }
      return [designShelfQ(kind, freq, gainDb, rq, sampleRate)];
    }
    case 'analog':
    default:
      if (slope === 6) return [designFirstOrderShelf(kind, freq, gainDb, sampleRate)];
      if (slope === 24) return [rbj(freq, gainDb / 2, q, sampleRate), rbj(freq, gainDb / 2, q, sampleRate)];
      return [rbj(freq, gainDb, q, sampleRate)];
  }
}

/**
 * The biquad cascade for one EQ band. `intensityScale` scales gain (and notch depth) like the
 * original renderer; `gainOverrideDb` replaces the (already scaled) gain, used by dynamic bands.
 */
export function designBandSections(
  band: Pick<EQBand, 'shape' | 'subtype' | 'slope' | 'freq' | 'gain' | 'q'>,
  sampleRate: number,
  intensityScale = 1,
): BiquadCoeffs[] {
  const scaledGain = band.gain * intensityScale;
  const subtype = resolveSubtype(band);
  const slope = resolveSlope(band);
  switch (band.shape) {
    case 'highpass':
      return designPass('high', subtype ?? 'flat', slope, band.freq, band.q, sampleRate);
    case 'lowpass':
      return designPass('low', subtype ?? 'flat', slope, band.freq, band.q, sampleRate);
    case 'lowshelf':
      return designShelfFamily('low', subtype ?? 'analog', slope, band.freq, scaledGain, band.q, sampleRate);
    case 'highshelf':
      return designShelfFamily('high', subtype ?? 'analog', slope, band.freq, scaledGain, band.q, sampleRate);
    case 'notch':
      return [designNotch(band.freq, band.q * Math.max(0.4, intensityScale), sampleRate)];
    case 'bandpass':
      return [designBandPass(band.freq, band.q, sampleRate)];
    case 'tilt':
      if (Math.abs(scaledGain) < 1e-4) return [{ ...IDENTITY }];
      return [
        designFirstOrderShelf('low', band.freq, -scaledGain / 2, sampleRate),
        designFirstOrderShelf('high', band.freq, scaledGain / 2, sampleRate),
      ];
    case 'bell':
    default:
      return designBellFamily(subtype ?? 'bell', band.freq, scaledGain, band.q, sampleRate);
  }
}

export function sectionsMagnitudeDb(sections: BiquadCoeffs[], freq: number, sampleRate: number): number {
  let db = 0;
  for (const c of sections) db += evaluateBiquadMagnitudeDb(c, freq, sampleRate);
  return db;
}

/** Original global tilt (complementary RBJ shelves at 650 Hz / 1.5 kHz). */
export function designGlobalTilt(tiltDb: number, sampleRate: number): BiquadCoeffs[] {
  if (Math.abs(tiltDb) <= 0.05) return [];
  return [designLowShelf(650, -tiltDb * 0.5, 0.55, sampleRate), designHighShelf(1500, tiltDb * 0.5, 0.55, sampleRate)];
}

/**
 * Solo / listen: a filter that isolates the band's region (what Ozone's S button plays).
 * Bell/notch/band-pass/tilt: band-pass at the band's Q; shelves: the shelved side; pass filters:
 * what the filter passes.
 */
export function designAuditionSections(band: EQBand, sampleRate: number): BiquadCoeffs[] {
  switch (band.shape) {
    case 'lowshelf':
      return [designLowPass(band.freq, SQRT1_2, sampleRate)];
    case 'highshelf':
      return [designHighPass(band.freq, SQRT1_2, sampleRate)];
    case 'lowpass':
    case 'highpass':
      return designBandSections({ ...band, gain: 0 }, sampleRate, 1);
    default: {
      const q = band.shape === 'bell' && resolveSubtype(band) === 'proportional' ? proportionalQ(band.q, band.gain) : band.q;
      return [designBandPass(band.freq, Math.max(0.3, q), sampleRate)];
    }
  }
}

/**
 * Auto-gain: the trim (dB) that cancels the EQ's average level change for a pink-like
 * (equal energy per octave) programme between 30 Hz and 16 kHz. Uses the stereo/mid curve.
 */
export function computeAutoGainDb(params: ParametricEQParams, sampleRate: number, intensityScale = 1): number {
  const groups = channelGroups(params, sampleRate, intensityScale);
  const sections = [...groups.stereo, ...groups.mid];
  if (sections.length === 0) return 0;
  const N = 96;
  let power = 0;
  for (let i = 0; i < N; i++) {
    const f = 30 * Math.pow(16000 / 30, (i + 0.5) / N);
    power += Math.pow(10, sectionsMagnitudeDb(sections, f, sampleRate) / 10);
  }
  const avgDb = 10 * Math.log10(power / N);
  return Math.max(-24, Math.min(24, -avgDb));
}

export interface EqChannelGroups {
  stereo: BiquadCoeffs[];
  mid: BiquadCoeffs[];
  side: BiquadCoeffs[];
  left: BiquadCoeffs[];
  right: BiquadCoeffs[];
}

/**
 * Sections grouped by channel, in render order. The global tilt joins the stereo group
 * (or mid, when the module is in mid-side mode), as in the original renderer.
 */
export function channelGroups(params: ParametricEQParams, sampleRate: number, intensityScale = 1): EqChannelGroups {
  const groups: EqChannelGroups = { stereo: [], mid: [], side: [], left: [], right: [] };
  for (const b of params.bands) {
    if (!b.enabled) continue;
    groups[bandChannel(b, params.msMode)].push(...designBandSections(b, sampleRate, intensityScale));
  }
  const tilt = designGlobalTilt(params.tiltDb * intensityScale, sampleRate);
  groups[params.msMode === 'mid-side' ? 'mid' : 'stereo'].push(...tilt);
  return groups;
}

/**
 * Display curves (dB) on `freqs`: the response heard by the mid (and mono) signal, plus
 * side / left / right when bands target them. Mirrors the renderer's processing order
 * (stereo bands, then M/S bands, then L/R bands) for a signal confined to that component.
 */
export function eqDisplayCurves(
  params: ParametricEQParams,
  sampleRate: number,
  freqs: number[],
): { main: number[]; side: number[] | null; left: number[] | null; right: number[] | null; autoGainDb: number } {
  const g = channelGroups(params, sampleRate, 1);
  const autoGainDb = params.autoGain ? computeAutoGainDb(params, sampleRate, 1) : 0;
  const curve = (secs: BiquadCoeffs[]) => freqs.map((f) => sectionsMagnitudeDb(secs, f, sampleRate) + autoGainDb);
  return {
    main: curve([...g.stereo, ...g.mid]),
    side: g.side.length ? curve([...g.stereo, ...g.side]) : null,
    left: g.left.length ? curve([...g.stereo, ...g.left]) : null,
    right: g.right.length ? curve([...g.stereo, ...g.right]) : null,
    autoGainDb,
  };
}

// ---------------------------------------------------------------------------
// Dynamic EQ curves
// ---------------------------------------------------------------------------

export const DYNAMIC_EQ_TYPES: DynamicEQBandType[] = [
  'proportional',
  'bell',
  'band-shelf',
  'baxandall-bass',
  'baxandall-treble',
  'low-shelf',
  'high-shelf',
];

export const DYNAMIC_TYPE_LABELS: Record<DynamicEQBandType, string> = {
  proportional: 'Proportional Q',
  bell: 'Bell',
  'band-shelf': 'Band Shelf',
  'baxandall-bass': 'Baxandall Bass',
  'baxandall-treble': 'Baxandall Treble',
  'low-shelf': 'Low Shelf',
  'high-shelf': 'High Shelf',
};

/** Static-band equivalent of a dynamic band type (for drawing and design). */
export function dynamicTypeAsBand(type: DynamicEQBandType | undefined): Pick<EQBand, 'shape' | 'subtype'> {
  switch (type) {
    case 'proportional':
      return { shape: 'bell', subtype: 'proportional' };
    case 'band-shelf':
      return { shape: 'bell', subtype: 'band-shelf' };
    case 'baxandall-bass':
      return { shape: 'lowshelf', subtype: 'baxandall' };
    case 'baxandall-treble':
      return { shape: 'highshelf', subtype: 'baxandall' };
    case 'low-shelf':
      return { shape: 'lowshelf', subtype: 'analog' };
    case 'high-shelf':
      return { shape: 'highshelf', subtype: 'analog' };
    case 'bell':
    default:
      return { shape: 'bell', subtype: 'bell' };
  }
}

/** Sections of a dynamic band at the given momentary gain. */
export function designDynamicSections(
  type: DynamicEQBandType | undefined,
  freq: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): BiquadCoeffs[] {
  const base = dynamicTypeAsBand(type);
  // Shelf Q is the RBJ shelf slope S; keep it in its stable range.
  const shelfQ = base.shape === 'bell' ? q : Math.max(0.3, Math.min(1.5, q / 2));
  return designBandSections({ ...base, freq, gain: gainDb, q: shelfQ }, sampleRate, 1);
}

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Nearest note (A4 = 440 Hz) and the offset in cents, e.g. 440 -> { note: 'A4', cents: 0 }. */
export function freqToNote(freq: number): { note: string; cents: number } {
  const midi = 69 + 12 * Math.log2(Math.max(1e-3, freq) / 440);
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12];
  const octave = Math.floor(nearest / 12) - 1;
  return { note: `${name}${octave}`, cents };
}

/** Lower and upper frequencies of a bell's bandwidth (for Q handles): f / r and f * r. */
export function qEdgeRatio(q: number): number {
  const bwOct = (2 / Math.LN2) * Math.asinh(1 / (2 * Math.max(0.1, q)));
  return Math.pow(2, bwOct / 2);
}

/** Inverse of qEdgeRatio: the Q whose bandwidth edges sit at f / ratio and f * ratio. */
export function qFromEdgeRatio(ratio: number): number {
  const bwOct = 2 * Math.log2(Math.max(1.0001, ratio));
  return 1 / (2 * Math.sinh((Math.LN2 / 2) * bwOct));
}

/** True when an active EQ / Dynamic EQ band is soloed: preview renders then audition it. */
export function chainHasSoloedBand(chain: ProcessorModule[]): boolean {
  return chain.some((m) => {
    if (!m.enabled || m.bypassed) return false;
    if (m.type !== 'parametric-eq' && m.type !== 'dynamic-eq') return false;
    const bands = (m.params as { bands?: Array<{ enabled?: boolean; solo?: boolean }> }).bands ?? [];
    return bands.some((b) => b.enabled !== false && b.solo === true);
  });
}
