import type {
  AudioDeviceInfo,
  ExternalPluginInstanceInfo,
  ExternalPluginRecord,
  HostConnectionStatus,
  HostInfo,
  ScanHistoryRecord,
  ScanProgressEvent,
  WasapiAuditionStatus,
} from '../types/mastering';

export interface HostBridgeSnapshot {
  status: HostConnectionStatus;
  hostPort: number;
  wsPort: number | null;
  hostInfo: HostInfo | null;
  plugins: ExternalPluginRecord[];
  instances: ExternalPluginInstanceInfo[];
  audioDevices: AudioDeviceInfo[];
  auditionStatus: WasapiAuditionStatus | null;
  scanHistory: ScanHistoryRecord[];
  scanProgress: ScanProgressEvent | null;
  isScanning: boolean;
  lastError: string | null;
  httpsPnaWarning: string | null;
}

export function encodeFloat32ArrayBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function decodeFloat32ArrayBase64(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SESSION_STORAGE_KEY = 'syn_master_host_session_v1';
const DEFAULT_HOST_PORT = 47832;

export function detectHttpsLocalhostGuidance(): string | null {
  if (typeof window === 'undefined') return null;
  const proto = window.location.protocol;
  const host = window.location.hostname;
  if (proto === 'https:' && host !== 'localhost' && host !== '127.0.0.1') {
    return (
      'Remote HTTPS origin detected (' +
      window.location.origin +
      '). Chromium permits loopback 127.0.0.1 access when Private Network Access headers are present; ' +
      'some browsers (Safari or strict tracking-protection Firefox) may block ws://127.0.0.1 from HTTPS pages unless opened locally.'
    );
  }
  return null;
}

export class SynHostBridge {
  private snapshot: HostBridgeSnapshot;
  private listeners = new Set<(snap: HostBridgeSnapshot) => void>();
  private ws: WebSocket | null = null;
  private sessionToken: string | null = null;
  private wsUrl: string | null = null;
  private nextRpcId = 1;
  private pendingRpcs = new Map<number, PendingRpc>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private manualDisconnect = false;

  constructor(initialPort = DEFAULT_HOST_PORT) {
    this.snapshot = {
      status: 'browser-only',
      hostPort: initialPort,
      wsPort: null,
      hostInfo: null,
      plugins: [],
      instances: [],
      audioDevices: [],
      auditionStatus: null,
      scanHistory: [],
      scanProgress: null,
      isScanning: false,
      lastError: null,
      httpsPnaWarning: detectHttpsLocalhostGuidance(),
    };
  }

  public getSnapshot(): HostBridgeSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: (snap: HostBridgeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(patch: Partial<HostBridgeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) {
      fn(this.snapshot);
    }
  }

  /**
   * Quietly checks URL fragment (#pairToken=...&hostPort=...) or saved sessionStorage token
   * without probing 127.0.0.1 blindly on normal browser-only page loads (prevents net::ERR_CONNECTION_REFUSED console errors).
   */
  public async tryRestoreOrPairFromLocation(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const pairToken = hashParams.get('pairToken') || searchParams.get('pairToken');
    const urlPortStr = hashParams.get('hostPort') || searchParams.get('hostPort');
    const parsedPort = urlPortStr ? Number(urlPortStr) : NaN;
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_HOST_PORT;

    if (pairToken) {
      // Scrub token from address bar hash/query immediately
      if (window.history && window.location.hash.includes('pairToken')) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      return this.connectAndPair({ hostPort: port, pairToken });
    }

    try {
      const saved = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { hostPort?: number; sessionToken?: string; wsUrl?: string };
        if (parsed.sessionToken && parsed.hostPort) {
          this.sessionToken = parsed.sessionToken;
          this.wsUrl = parsed.wsUrl ?? null;
          return this.connectWithExistingSession(parsed.hostPort, parsed.sessionToken);
        }
      }
    } catch {
      // Ignore malformed sessionStorage
    }
    return false;
  }

  public async connectAndPair(opts: {
    hostPort?: number;
    pairingCode?: string;
    pairToken?: string;
  }): Promise<boolean> {
    const port = opts.hostPort ?? this.snapshot.hostPort ?? DEFAULT_HOST_PORT;
    this.manualDisconnect = false;
    this.clearReconnectTimer();
    this.emit({
      status: 'connecting',
      hostPort: port,
      lastError: null,
      httpsPnaWarning: detectHttpsLocalhostGuidance(),
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const healthRes = await fetch(`${baseUrl}/v1/health`, {
        method: 'GET',
        mode: 'cors',
      });
      if (!healthRes.ok) {
        this.emit({
          status: 'unavailable',
          lastError: `Companion host health check returned HTTP ${healthRes.status}.`,
        });
        return false;
      }
      const health = (await healthRes.json()) as {
        wsPort?: number;
        wsUrl?: string;
        requiresPairing?: boolean;
      };

      const code = opts.pairingCode?.trim();
      const tok = opts.pairToken?.trim();
      if (!code && !tok) {
        this.emit({
          status: 'pairing-required',
          wsPort: health.wsPort ?? null,
          lastError: 'Enter the Pairing Code displayed in the Windows syn-plugin-host console.',
        });
        return false;
      }

      const pairRes = await fetch(`${baseUrl}/v1/auth/pair`, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairingCode: code || undefined,
          pairToken: tok || undefined,
        }),
      });

      const pairJson = (await pairRes.json().catch(() => ({}))) as {
        paired?: boolean;
        sessionToken?: string;
        wsUrl?: string;
        error?: string;
      };

      if (!pairRes.ok || !pairJson.paired || !pairJson.sessionToken) {
        this.emit({
          status: 'pairing-required',
          wsPort: health.wsPort ?? null,
          lastError: pairJson.error || `Pairing failed (HTTP ${pairRes.status}). Check the pairing code.`,
        });
        return false;
      }

      this.sessionToken = pairJson.sessionToken;
      this.wsUrl = pairJson.wsUrl || `ws://127.0.0.1:${health.wsPort ?? port + 1}/ws`;
      this.persistSession(port, this.sessionToken, this.wsUrl);
      await this.openAuthenticatedWebSocket(this.wsUrl, this.sessionToken, port);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to reach localhost companion';
      const pnaNote =
        detectHttpsLocalhostGuidance()
          ? ' Ensure syn-plugin-host is running locally on Windows 11 and Private Network Access is permitted in your browser.'
          : ' Ensure syn-plugin-host.exe is running on http://127.0.0.1:' + port + '.';
      this.emit({
        status: 'unavailable',
        lastError: `${msg}.${pnaNote}`,
      });
      return false;
    }
  }

  public async connectWithExistingSession(port: number, sessionToken: string): Promise<boolean> {
    this.manualDisconnect = false;
    this.emit({ status: 'connecting', hostPort: port, lastError: null });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const healthRes = await fetch(`${baseUrl}/v1/health`, { method: 'GET', mode: 'cors' });
      if (!healthRes.ok) {
        this.emit({ status: 'unavailable', lastError: `Host health HTTP ${healthRes.status}` });
        return false;
      }
      const health = (await healthRes.json()) as { wsPort?: number; wsUrl?: string };
      const wsUrl = health.wsUrl || this.wsUrl || `ws://127.0.0.1:${health.wsPort ?? port + 1}/ws`;
      this.wsUrl = wsUrl;
      await this.openAuthenticatedWebSocket(wsUrl, sessionToken, port);
      return true;
    } catch (err) {
      this.emit({
        status: 'unavailable',
        lastError: err instanceof Error ? err.message : 'Could not reach companion host',
      });
      return false;
    }
  }

  private openAuthenticatedWebSocket(wsUrl: string, sessionToken: string, port: number): Promise<void> {
    this.closeSocketOnly();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = async () => {
        try {
          await this.sendRpcInternal('host.auth', { sessionToken });
          this.reconnectAttempts = 0;
          this.emit({
            status: 'connected',
            hostPort: port,
            lastError: null,
          });
          await this.refreshAll();
          if (!settled) {
            settled = true;
            resolve();
          }
        } catch (err) {
          this.clearSavedSession();
          const msg = err instanceof Error ? err.message : 'Host WebSocket authentication failed';
          this.emit({
            status: 'pairing-required',
            lastError: msg,
          });
          ws.close();
          if (!settled) {
            settled = true;
            reject(new Error(msg));
          }
        }
      };

      ws.onmessage = (evt) => {
        this.handleWsMessage(String(evt.data));
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket connection failed (${wsUrl})`));
        }
      };

      ws.onclose = (ev) => {
        this.rejectAllPending(new Error('WebSocket closed (' + ev.code + ')'));
        if (this.ws === ws) {
          this.ws = null;
        }
        if (this.manualDisconnect) {
          return;
        }
        if (ev.code === 4001 || ev.code === 4003) {
          this.clearSavedSession();
          this.emit({
            status: 'pairing-required',
            lastError: ev.reason || 'Host rejected session token or origin.',
          });
          return;
        }
        if (this.snapshot.status === 'connected' || this.sessionToken) {
          this.emit({
            status: 'disconnected',
            isScanning: false,
            lastError: 'Lost connection to companion host. Attempting reconnect...',
          });
          this.scheduleReconnect();
        }
      };
    });
  }

  private handleWsMessage(raw: string) {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pendingRpcs.get(msg.id);
      if (!pending) return;
      this.pendingRpcs.delete(msg.id);
      globalThis.clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || `RPC error ${msg.error.code ?? -1}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method === 'catalog.scanProgress' && msg.params && typeof msg.params === 'object') {
      const p = msg.params as ScanProgressEvent;
      const done = p.total > 0 && p.completed >= p.total;
      this.emit({
        scanProgress: p,
        isScanning: !done,
      });
      if (done) {
        void this.refreshCatalogAndHistory();
      }
    }
  }

  private sendRpcInternal<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to companion host'));
    }
    const id = this.nextRpcId++;
    return new Promise<T>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`RPC timeout calling ${method}`));
      }, 20000);
      this.pendingRpcs.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.ws!.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params,
        }),
      );
    });
  }

  public async refreshAll(): Promise<void> {
    const [info, catalog, history, instRes, devRes] = await Promise.all([
      this.sendRpcInternal<HostInfo>('host.info'),
      this.sendRpcInternal<{ plugins: ExternalPluginRecord[] }>('catalog.list'),
      this.sendRpcInternal<{ history: ScanHistoryRecord[] }>('catalog.history'),
      this.sendRpcInternal<{ instances: ExternalPluginInstanceInfo[] }>('plugin.listInstances').catch(() => ({
        instances: [],
      })),
      this.sendRpcInternal<{ devices: AudioDeviceInfo[] }>('audio.devices').catch(() => ({
        devices: [],
      })),
    ]);
    this.emit({
      hostInfo: info,
      plugins: catalog.plugins ?? [],
      scanHistory: history.history ?? [],
      instances: instRes.instances ?? [],
      audioDevices: devRes.devices ?? [],
    });
  }

  public async refreshCatalogAndHistory(): Promise<void> {
    if (this.snapshot.status !== 'connected') return;
    const [catalog, history, info] = await Promise.all([
      this.sendRpcInternal<{ plugins: ExternalPluginRecord[] }>('catalog.list'),
      this.sendRpcInternal<{ history: ScanHistoryRecord[] }>('catalog.history'),
      this.sendRpcInternal<HostInfo>('host.info'),
    ]);
    this.emit({
      plugins: catalog.plugins ?? [],
      scanHistory: history.history ?? [],
      hostInfo: info,
      isScanning: false,
    });
  }

  public async triggerScan(mode: 'incremental' | 'full' | 'force'): Promise<void> {
    this.emit({
      isScanning: true,
      scanProgress: { completed: 0, total: 0, currentBundle: 'Collecting bundles...', status: 'scanning' },
      lastError: null,
    });
    const res = await this.sendRpcInternal<{ started: boolean; alreadyRunning?: boolean }>('catalog.scan', { mode });
    if (!res.started && !res.alreadyRunning) {
      this.emit({ isScanning: false });
    }
  }

  public async retryPlugin(uid: string, bundlePath: string): Promise<void> {
    this.emit({
      isScanning: true,
      scanProgress: { completed: 0, total: 1, currentBundle: bundlePath, status: 'retrying' },
    });
    await this.sendRpcInternal('catalog.retryPlugin', { uid, bundlePath });
  }

  public async addCustomDirectory(path: string): Promise<void> {
    await this.sendRpcInternal('catalog.paths.add', { path });
    await this.refreshAll();
  }

  public async removeCustomDirectory(path: string): Promise<void> {
    await this.sendRpcInternal('catalog.paths.remove', { path });
    await this.refreshAll();
  }

  public async setPluginPreference(
    uid: string,
    bundlePath: string,
    prefs: { favorite?: boolean; disabledByUser?: boolean; lastUsedAt?: number },
  ): Promise<void> {
    await this.sendRpcInternal('catalog.setPreference', { uid, bundlePath, ...prefs });
    await this.refreshCatalogAndHistory();
  }

  // ---------------- Milestone 2 Execution & Audio Methods ----------------

  public async loadPluginInstance(opts: {
    uid: string;
    bundlePath: string;
    sampleRate?: number;
    blockSize?: number;
    channels?: number;
  }): Promise<ExternalPluginInstanceInfo> {
    const info = await this.sendRpcInternal<ExternalPluginInstanceInfo>('plugin.load', {
      uid: opts.uid,
      bundlePath: opts.bundlePath,
      sampleRate: opts.sampleRate ?? 48000,
      blockSize: opts.blockSize ?? 512,
      channels: opts.channels ?? 2,
    });
    const next = [...this.snapshot.instances.filter((i) => i.instanceId !== info.instanceId), info];
    this.emit({ instances: next });
    return info;
  }

  public async unloadPluginInstance(instanceId: string): Promise<void> {
    await this.sendRpcInternal('plugin.unload', { instanceId });
    this.emit({
      instances: this.snapshot.instances.filter((i) => i.instanceId !== instanceId),
    });
  }

  public async setPluginParameter(
    instanceId: string,
    paramId: number,
    valueNormalized: number,
  ): Promise<{ instanceId: string; paramId: number; valueNormalized: number; displayValue: string }> {
    const res = await this.sendRpcInternal<{
      instanceId: string;
      paramId: number;
      valueNormalized: number;
      displayValue: string;
    }>('plugin.setParameter', { instanceId, paramId, valueNormalized });
    return res;
  }

  public async getPluginParameters(instanceId: string): Promise<ExternalPluginInstanceInfo['parameters']> {
    const res = await this.sendRpcInternal<{
      instanceId: string;
      parameters: ExternalPluginInstanceInfo['parameters'];
    }>('plugin.getParameters', { instanceId });
    return res.parameters ?? [];
  }

  public async setPluginBypass(instanceId: string, bypassed: boolean): Promise<void> {
    await this.sendRpcInternal('plugin.setBypass', { instanceId, bypassed });
  }

  public async getPluginState(instanceId: string): Promise<string> {
    const res = await this.sendRpcInternal<{ stateBase64: string }>('plugin.getState', { instanceId });
    return res.stateBase64 ?? '';
  }

  public async setPluginState(instanceId: string, stateBase64: string): Promise<void> {
    await this.sendRpcInternal('plugin.setState', { instanceId, stateBase64 });
  }

  public async openPluginEditor(instanceId: string): Promise<void> {
    await this.sendRpcInternal('plugin.openEditor', { instanceId });
  }

  public async closePluginEditor(instanceId: string): Promise<void> {
    await this.sendRpcInternal('plugin.closeEditor', { instanceId });
  }

  public async refreshAudioDevices(): Promise<AudioDeviceInfo[]> {
    const res = await this.sendRpcInternal<{ devices: AudioDeviceInfo[] }>('audio.devices');
    const devices = res.devices ?? [];
    this.emit({ audioDevices: devices });
    return devices;
  }

  public async processAudioOffline(
    instanceIds: string[],
    sampleRate: number,
    channels: Float32Array[],
    blockSize = 512,
  ): Promise<{ channels: Float32Array[]; totalLatencySamples: number; durationMs: number }> {
    if (this.snapshot.status !== 'connected' || !this.sessionToken) {
      throw new Error('Companion host is not connected');
    }
    const left = channels[0];
    const right = channels[1] ?? channels[0];
    const url = `http://127.0.0.1:${this.snapshot.hostPort}/v1/audio/process-offline`;
    const res = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify({
        instanceIds,
        sampleRate,
        blockSize,
        leftBase64: encodeFloat32ArrayBase64(left),
        rightBase64: encodeFloat32ArrayBase64(right),
      }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      leftBase64?: string;
      rightBase64?: string;
      totalLatencySamples?: number;
      durationMs?: number;
    };

    if (!res.ok || !data.ok || !data.leftBase64 || !data.rightBase64) {
      throw new Error(data.error || `Host offline processing failed (HTTP ${res.status})`);
    }

    return {
      channels: [decodeFloat32ArrayBase64(data.leftBase64), decodeFloat32ArrayBase64(data.rightBase64)],
      totalLatencySamples: data.totalLatencySamples ?? 0,
      durationMs: data.durationMs ?? 0,
    };
  }

  public async startWasapiAudition(
    channels: Float32Array[],
    sampleRate: number,
    deviceId = '',
    loop = true,
  ): Promise<WasapiAuditionStatus> {
    const res = await this.sendRpcInternal<WasapiAuditionStatus>('audio.auditionStart', {
      leftBase64: encodeFloat32ArrayBase64(channels[0]),
      rightBase64: encodeFloat32ArrayBase64(channels[1] ?? channels[0]),
      sampleRate,
      deviceId,
      loop,
    });
    this.emit({ auditionStatus: res });
    return res;
  }

  public async stopWasapiAudition(): Promise<void> {
    await this.sendRpcInternal('audio.auditionStop');
    this.emit({ auditionStatus: { active: false } });
  }

  public disconnect() {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.clearSavedSession();
    this.sessionToken = null;
    this.wsUrl = null;
    this.closeSocketOnly();
    this.emit({
      status: 'browser-only',
      hostInfo: null,
      plugins: [],
      instances: [],
      audioDevices: [],
      auditionStatus: null,
      scanHistory: [],
      scanProgress: null,
      isScanning: false,
      lastError: null,
    });
  }

  private scheduleReconnect() {
    if (this.manualDisconnect || !this.sessionToken || this.reconnectAttempts >= 4) {
      return;
    }
    this.clearReconnectTimer();
    const delayMs = Math.min(8000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = globalThis.setTimeout(() => {
      if (!this.manualDisconnect && this.sessionToken) {
        void this.connectWithExistingSession(this.snapshot.hostPort, this.sessionToken);
      }
    }, delayMs);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocketOnly() {
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.rejectAllPending(new Error('Socket reset'));
  }

  private rejectAllPending(err: Error) {
    for (const [, p] of this.pendingRpcs) {
      globalThis.clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingRpcs.clear();
  }

  private persistSession(hostPort: number, sessionToken: string, wsUrl: string) {
    try {
      window.sessionStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({ hostPort, sessionToken, wsUrl }),
      );
    } catch {
      // ignore
    }
  }

  private clearSavedSession() {
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
