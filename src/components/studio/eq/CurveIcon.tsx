import React from 'react';

/** Small curve glyphs for the Type menus (drawn in a 28x20 box, stroke = currentColor). */
const PATHS: Record<string, string> = {
  bell: 'M2,16 C9,16 10,3 14,3 C18,3 19,16 26,16',
  proportional: 'M2,16 C11,16 12,2 14,2 C16,2 17,16 26,16',
  'band-shelf': 'M2,16 C6,16 7,5 10,5 L18,5 C21,5 22,16 26,16',
  lowshelf: 'M2,5 C9,5 12,15 16,15 L26,15',
  highshelf: 'M2,15 L12,15 C16,15 19,5 26,5',
  'lowshelf-analog': 'M2,5 C9,5 12,15 16,15 L26,15',
  'lowshelf-baxandall': 'M2,4 C10,6 14,13 26,15',
  'lowshelf-vintage': 'M2,5 C8,5 10,12 13,17 C15,19 17,14 26,14',
  'lowshelf-resonant': 'M2,6 C7,6 8,3 10,3 C12,3 13,17 15,17 C17,17 18,14 26,14',
  'highshelf-analog': 'M2,15 L12,15 C16,15 19,5 26,5',
  'highshelf-baxandall': 'M2,15 C14,13 18,6 26,4',
  'highshelf-vintage': 'M2,14 C11,14 13,19 15,17 C18,12 20,5 26,5',
  'highshelf-resonant': 'M2,14 C10,14 11,17 13,17 C15,17 16,3 18,3 C20,3 21,6 26,6',
  lowpass: 'M2,6 L12,6 C17,6 19,10 22,17',
  'lowpass-flat': 'M2,6 L12,6 C17,6 19,10 22,17',
  'lowpass-resonant': 'M2,8 L10,8 C13,8 14,3 16,3 C18,3 19,12 21,17',
  'lowpass-brickwall': 'M2,6 L19,6 L19,17',
  highpass: 'M6,17 C9,10 11,6 16,6 L26,6',
  'highpass-flat': 'M6,17 C9,10 11,6 16,6 L26,6',
  'highpass-resonant': 'M7,17 C9,12 10,3 12,3 C14,3 15,8 18,8 L26,8',
  'highpass-brickwall': 'M9,17 L9,6 L26,6',
  notch: 'M2,6 L11,6 C13,6 13,18 14,18 C15,18 15,6 17,6 L26,6',
  bandpass: 'M2,17 C8,17 10,5 14,5 C18,5 20,17 26,17',
  tilt: 'M2,15 C10,14 18,6 26,5',
  'baxandall-bass': 'M2,4 C10,6 14,13 26,15',
  'baxandall-treble': 'M2,15 C14,13 18,6 26,4',
  'low-shelf': 'M2,5 C9,5 12,15 16,15 L26,15',
  'high-shelf': 'M2,15 L12,15 C16,15 19,5 26,5',
};

export const CurveIcon: React.FC<{ kind: string; className?: string }> = ({ kind, className }) => (
  <svg viewBox="0 0 28 20" width={28} height={20} className={className} aria-hidden="true" focusable="false">
    <path d={PATHS[kind] ?? PATHS.bell} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
