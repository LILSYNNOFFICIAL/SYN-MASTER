import type { LiveMeterSnapshot } from './audioEngine';

export interface RuntimeTelemetryState {
  isPlaying: boolean;
  currentTimeSec: number;
  live: LiveMeterSnapshot | null;
}

type TelemetryListener = (state: RuntimeTelemetryState) => void;

class TelemetryStore {
  private state: RuntimeTelemetryState = {
    isPlaying: false,
    currentTimeSec: 0,
    live: null,
  };

  private listeners = new Set<TelemetryListener>();

  public getSnapshot(): RuntimeTelemetryState {
    return this.state;
  }

  public publish(patch: Partial<RuntimeTelemetryState>): void {
    this.state = {
      isPlaying: patch.isPlaying !== undefined ? patch.isPlaying : this.state.isPlaying,
      currentTimeSec:
        patch.currentTimeSec !== undefined ? patch.currentTimeSec : this.state.currentTimeSec,
      live: patch.live !== undefined ? patch.live : this.state.live,
    };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  public subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getListenerCount(): number {
    return this.listeners.size;
  }

  public reset(): void {
    this.publish({
      isPlaying: false,
      currentTimeSec: 0,
      live: null,
    });
  }
}

export const telemetryStore = new TelemetryStore();
export { TelemetryStore };
