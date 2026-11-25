import React from 'react';
import { Radio } from 'lucide-react';
import { PLATFORM_PROFILES, predictForPlatform, type MasterLevels, type PlatformId, type SpotifyLevel } from '../../dsp/platformRules';
import { platformPreviewStore } from '../../engine/platformPreviewStore';
import './platformPreview.css';

import { usePlatformPreviewSelection } from './usePlatformPreviewSelection';

const fmtDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`;

/**
 * Compact Platform Preview selector for the transport. Monitoring only: picking a platform
 * changes what you hear (its playback gain), never the master that renders or exports.
 */
export const PlatformPreviewSelector: React.FC<{ levels: MasterLevels | null; onOpenPanel?: () => void }> = ({ levels, onOpenPanel }) => {
  const sel = usePlatformPreviewSelection();
  const p = levels ? predictForPlatform(levels, sel.platformId, sel.spotifyLevel) : null;
  const active = sel.platformId !== 'off';
  return (
    <div className={`syn-pp-compact${active ? ' is-active' : ''}`} role="group" aria-label="Platform Preview (monitoring only)">
      <Radio className="syn-pp-icon" aria-hidden="true" />
      <label className="syn-pp-field">
        <span className="syn-pp-sr">Hear as platform</span>
        <select
          value={sel.platformId}
          onChange={(e) => platformPreviewStore.set({ platformId: e.target.value as PlatformId })}
          aria-label="Platform Preview: hear the master as this platform plays it"
          title="Platform Preview (monitoring only; does not change the export)"
        >
          {PLATFORM_PROFILES.map((pr) => <option key={pr.id} value={pr.id}>{pr.id === 'off' ? 'Platform: Off' : pr.label}</option>)}
        </select>
      </label>
      {sel.platformId === 'spotify' && (
        <label className="syn-pp-field">
          <span className="syn-pp-sr">Spotify volume level</span>
          <select
            value={sel.spotifyLevel}
            onChange={(e) => platformPreviewStore.set({ spotifyLevel: e.target.value as SpotifyLevel })}
            aria-label="Spotify volume level"
          >
            <option value="normal">Normal −14</option>
            <option value="loud">Loud −11</option>
            <option value="quiet">Quiet −19</option>
          </select>
        </label>
      )}
      {active && p && (
        <span className={`syn-pp-readout risk-${p.risk}`} aria-live="polite">
          <b>{fmtDb(p.gainDb)} dB</b>
          <span className="syn-pp-tp">TP {p.predictedTruePeakDb.toFixed(1)}</span>
          {p.limiterEngaged && <span className="syn-pp-tag">limiter</span>}
        </span>
      )}
      {active && onOpenPanel && (
        <button type="button" className="syn-pp-more" onClick={onOpenPanel} aria-label="Open the full Platform Preview panel in Quality Control">Details</button>
      )}
    </div>
  );
};

export default PlatformPreviewSelector;
