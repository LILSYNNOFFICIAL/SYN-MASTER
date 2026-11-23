/**
 * Single source of truth for SYN MASTER's spectral band definitions.
 * The analyzer zones, the diagnosis, the Director and post-fix verification all
 * read these ranges, so a "Low-Mid" or "mud region" reading means the same thing everywhere.
 */
export const SPECTRAL_ZONES_HZ = {
  sub: [20, 60],
  bass: [60, 250],
  lowMid: [250, 500],
  mid: [500, 2000],
  highMid: [2000, 6000],
  presence: [6000, 12000],
  air: [12000, 20000],
} as const;

/**
 * Masking / mud region checked against Mid. It deliberately straddles the upper bass
 * and lower low-mid zones (vocal body, snare body, kick/bass harmonics).
 */
export const MUD_REGION_HZ = [150, 400] as const;

/** Where the Director places low-mid corrections inside the mud region. */
export const MUD_CORRECTION_HZ = { center: 270, min: 170, max: 360 } as const;
