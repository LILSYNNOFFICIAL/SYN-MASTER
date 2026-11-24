import React from 'react';

/**
 * Decorative flowing light-wave ribbons behind the console (pure SVG + CSS transform
 * animation, no JS loop). Animation is disabled under prefers-reduced-motion in CSS.
 */
const RIBBONS = [
  { d: 'M-50 120 C 180 40, 360 200, 600 110 S 1000 30, 1250 120', w: 1.6, o: 0.75 },
  { d: 'M-50 135 C 200 70, 380 220, 620 128 S 1020 50, 1250 140', w: 1, o: 0.55 },
  { d: 'M-50 150 C 220 100, 400 240, 640 146 S 1040 70, 1250 160', w: 0.8, o: 0.4 },
  { d: 'M-50 165 C 240 130, 420 255, 660 164 S 1060 90, 1250 178', w: 0.6, o: 0.3 },
  { d: 'M-50 100 C 160 20, 340 170, 580 90 S 980 10, 1250 96', w: 0.7, o: 0.35 },
];

export const LightRibbons: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg className={`syn-ribbons ${className}`} viewBox="0 0 1200 260" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="syn-ribbon-grad" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stopColor="#2F8BFF" stopOpacity="0" />
        <stop offset="18%" stopColor="#2F8BFF" stopOpacity="0.9" />
        <stop offset="50%" stopColor="#5EC8FF" stopOpacity="0.35" />
        <stop offset="82%" stopColor="#2F8BFF" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#2F8BFF" stopOpacity="0" />
      </linearGradient>
      <filter id="syn-ribbon-glow" x="-5%" y="-50%" width="110%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>
    <g filter="url(#syn-ribbon-glow)" fill="none" stroke="url(#syn-ribbon-grad)">
      {RIBBONS.map((r, i) => (
        <path key={i} d={r.d} strokeWidth={r.w} strokeOpacity={r.o} className={`syn-ribbon syn-ribbon-${i}`} />
      ))}
    </g>
  </svg>
);
