import { isPlatformId, type PlatformId, type SpotifyLevel } from '../dsp/platformRules';

/**
 * Platform Preview selection shared by the compact transport selector and the QC panel.
 * Monitoring state only: it changes what the user hears on the playback bus, never a render.
 */
export interface PlatformPreviewSelection {
  platformId: PlatformId;
  spotifyLevel: SpotifyLevel;
}

const STORAGE_KEY = 'syn-master.platform-preview.v1';
type Listener = (s: PlatformPreviewSelection) => void;

function load(): PlatformPreviewSelection {
  const fallback: PlatformPreviewSelection = { platformId: 'off', spotifyLevel: 'normal' };
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PlatformPreviewSelection>;
    return {
      platformId: isPlatformId(parsed.platformId) ? parsed.platformId : 'off',
      spotifyLevel: parsed.spotifyLevel === 'loud' || parsed.spotifyLevel === 'quiet' ? parsed.spotifyLevel : 'normal',
    };
  } catch {
    return fallback;
  }
}

class PlatformPreviewStore {
  private state: PlatformPreviewSelection = load();
  private listeners = new Set<Listener>();

  getSnapshot = (): PlatformPreviewSelection => this.state;

  set(patch: Partial<PlatformPreviewSelection>): void {
    this.state = { ...this.state, ...patch };
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // private mode / quota: keep the in-memory selection
    }
    for (const l of this.listeners) l(this.state);
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

export const platformPreviewStore = new PlatformPreviewStore();
