import type { LiveMeterSnapshot } from './audioEngine';

export interface RuntimeTelemetryState {
  isPlaying: boolean;
  currentTimeSec: number;
  live: LiveMeterSnapshot | null;
}

type TelemetryListener = (state: RuntimeTelemetryState) => void;

export class TelemetryStore {
  private state: RuntimeTelemetryState = { isPlaying: false, currentTimeSec: 0, live: null };
  private readonly listeners = new Set<TelemetryListener>();

  public getSnapshot(): RuntimeTelemetryState {
    return this.state;
  }

  public publish(patch: Partial<RuntimeTelemetryState>): void {
    const nextTime = patch.currentTimeSec ?? this.state.currentTimeSec;
    this.state = {
      isPlaying: patch.isPlaying ?? this.state.isPlaying,
      currentTimeSec: Number.isFinite(nextTime) ? Math.max(0, nextTime) : this.state.currentTimeSec,
      live: patch.live !== undefined ? patch.live : this.state.live,
    };

    // One faulty subscriber must not prevent other visualizers receiving telemetry.
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch (error) {
        console.error('[SYN MASTER] Telemetry subscriber failed:', error);
      }
    }
  }

  public subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public getListenerCount(): number {
    return this.listeners.size;
  }

  public reset(): void {
    this.publish({ isPlaying: false, currentTimeSec: 0, live: null });
  }
}

export const telemetryStore = new TelemetryStore();
