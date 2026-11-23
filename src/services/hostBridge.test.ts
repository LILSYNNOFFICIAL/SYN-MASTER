import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { decodeFloat32ArrayBase64, encodeFloat32ArrayBase64, SynHostBridge } from './hostBridge';

/**
 * TEST-ONLY local loopback HTTP + RFC-6455 WebSocket + node:sqlite test harness.
 * Verifies authentication, Origin/PNA enforcement, JSON-RPC 2.0 protocol, SQLite persistence,
 * child-process crash/timeout isolation, Milestone 2 instance lifecycle / offline audio HTTP routing,
 * and SynHostBridge reconnect/disconnect behavior.
 * Never bundled into the production SYN MASTER application.
 */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser curl/node clients without Origin header
  if (origin === 'null') return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9.-]+\.run\.app(:\d+)?$/i.test(origin)) return true;
  return false;
}

function encodeWsFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }
  if (len < 65536) {
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x81;
    hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
    return Buffer.concat([hdr, payload]);
  }
  const hdr = Buffer.alloc(10);
  hdr[0] = 0x81;
  hdr[1] = 127;
  hdr.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([hdr, payload]);
}

function encodeWsClose(code: number, reason: string): Buffer {
  const r = Buffer.from(reason, 'utf8');
  const body = Buffer.alloc(2 + r.length);
  body.writeUInt16BE(code, 0);
  r.copy(body, 2);
  return Buffer.concat([Buffer.from([0x88, body.length]), body]);
}

interface WsClient {
  socket: net.Socket;
  authenticated: boolean;
  sendJson: (obj: unknown) => void;
  closeWith: (code: number, reason: string) => void;
}

interface MockInstance {
  instanceId: string;
  pluginUid: string;
  pluginName: string;
  bundlePath: string;
  latencySamples: number;
  hasEditor: boolean;
  editorOpen: boolean;
  bypassed: boolean;
  gainNormalized: number;
  tiltNormalized: number;
}

function createTestHostServer() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE plugins (
      uid TEXT NOT NULL,
      format TEXT NOT NULL,
      name TEXT NOT NULL,
      manufacturer TEXT NOT NULL,
      version TEXT NOT NULL,
      sdk_version TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategories_json TEXT NOT NULL,
      bundle_path TEXT NOT NULL,
      binary_path TEXT NOT NULL,
      arch TEXT NOT NULL,
      status TEXT NOT NULL,
      status_reason TEXT NOT NULL,
      has_editor INTEGER NOT NULL,
      latency_samples INTEGER NOT NULL,
      bus_configs_json TEXT NOT NULL,
      parameter_count INTEGER NOT NULL,
      parameters_json TEXT NOT NULL,
      file_mtime_ns INTEGER NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      file_hash_sha256 TEXT NOT NULL,
      fail_count INTEGER NOT NULL,
      last_scanned_at INTEGER NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      disabled_by_user INTEGER NOT NULL DEFAULT 0,
      UNIQUE(uid, bundle_path)
    );
    CREATE TABLE custom_directories (
      path TEXT NOT NULL UNIQUE,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE scan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      mode TEXT NOT NULL,
      total_bundles INTEGER NOT NULL,
      discovered_plugins INTEGER NOT NULL,
      failed_bundles INTEGER NOT NULL,
      skipped_unchanged INTEGER NOT NULL,
      summary TEXT NOT NULL
    );
  `);

  const pairingCode = 'SYN-TEST-8842';
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const clients = new Set<WsClient>();
  const instances = new Map<string, MockInstance>();
  let nextInstSeq = 1;
  let auditionActive = false;
  let auditionSampleRate = 48000;

  let currentScanScenario: 'initial' | 'updated_and_missing' = 'initial';

  function upsertPluginRow(p: Record<string, unknown>) {
    const stmt = db.prepare(`
      INSERT INTO plugins (
        uid, format, name, manufacturer, version, sdk_version, category,
        subcategories_json, bundle_path, binary_path, arch, status, status_reason,
        has_editor, latency_samples, bus_configs_json, parameter_count, parameters_json,
        file_mtime_ns, file_size_bytes, file_hash_sha256, fail_count, last_scanned_at,
        favorite, last_used_at, disabled_by_user
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uid, bundle_path) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        status = excluded.status,
        status_reason = excluded.status_reason,
        latency_samples = excluded.latency_samples,
        file_hash_sha256 = excluded.file_hash_sha256,
        fail_count = excluded.fail_count,
        last_scanned_at = excluded.last_scanned_at
    `);
    stmt.run(
      String(p.uid),
      String(p.format),
      String(p.name),
      String(p.manufacturer),
      String(p.version),
      String(p.sdkVersion),
      String(p.category),
      JSON.stringify(p.subCategories ?? []),
      String(p.bundlePath),
      String(p.binaryPath),
      String(p.arch),
      String(p.status),
      String(p.statusReason ?? ''),
      p.hasEditor ? 1 : 0,
      Number(p.latencySamples ?? 0),
      JSON.stringify(p.busConfigs ?? []),
      Number(p.parameterCount ?? 0),
      JSON.stringify(p.parameters ?? []),
      Number(p.fileMtimeNs ?? 0),
      Number(p.fileSizeBytes ?? 0),
      String(p.fileHashSha256 ?? ''),
      Number(p.failCount ?? 0),
      Number(p.lastScannedAt ?? Date.now()),
      p.favorite ? 1 : 0,
      Number(p.lastUsedAt ?? 0),
      p.disabledByUser ? 1 : 0,
    );
  }

  function listPlugins() {
    const rows = db.prepare('SELECT * FROM plugins ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      uid: r.uid,
      format: r.format,
      name: r.name,
      manufacturer: r.manufacturer,
      version: r.version,
      sdkVersion: r.sdk_version,
      category: r.category,
      subCategories: JSON.parse(String(r.subcategories_json)),
      bundlePath: r.bundle_path,
      binaryPath: r.binary_path,
      arch: r.arch,
      status: r.status,
      statusReason: r.status_reason,
      hasEditor: Boolean(r.has_editor),
      latencySamples: r.latency_samples,
      busConfigs: JSON.parse(String(r.bus_configs_json)),
      parameterCount: r.parameter_count,
      parameters: JSON.parse(String(r.parameters_json)),
      fileMtimeNs: r.file_mtime_ns,
      fileSizeBytes: r.file_size_bytes,
      fileHashSha256: r.file_hash_sha256,
      failCount: r.fail_count,
      lastScannedAt: r.last_scanned_at,
      favorite: Boolean(r.favorite),
      lastUsedAt: r.last_used_at,
      disabledByUser: Boolean(r.disabled_by_user),
    }));
  }

  const server = http.createServer((req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (origin && !isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not authorized' }));
      return;
    }
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Private-Network': 'true',
      'Content-Type': 'application/json',
    };
    if (origin) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
      corsHeaders['Vary'] = 'Origin';
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const address = server.address() as net.AddressInfo;
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

    if (req.method === 'GET' && req.url === '/v1/health') {
      res.writeHead(200, corsHeaders);
      res.end(
        JSON.stringify({
          status: 'ok',
          hostVersion: '0.2.0-test',
          os: 'windows-x64',
          milestone: 2,
          formatsSupported: ['vst3'],
          audioEngineActive: true,
          wsPort: address.port,
          wsUrl,
          requiresPairing: true,
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/auth/pair') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as { pairingCode?: string; pairToken?: string };
          const ok =
            parsed.pairingCode === pairingCode ||
            parsed.pairToken === sessionToken;
          if (!ok) {
            res.writeHead(401, corsHeaders);
            res.end(JSON.stringify({ error: 'Invalid pairing code or token' }));
            return;
          }
          res.writeHead(200, corsHeaders);
          res.end(
            JSON.stringify({
              paired: true,
              sessionToken,
              wsUrl,
            }),
          );
        } catch {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: 'Malformed JSON' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/audio/process-offline') {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${sessionToken}`) {
        res.writeHead(401, corsHeaders);
        res.end(JSON.stringify({ error: 'Missing or invalid Bearer session token' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as {
            instanceIds?: string[];
            sampleRate?: number;
            leftBase64?: string;
            rightBase64?: string;
          };
          const leftBuf = Buffer.from(parsed.leftBase64 || '', 'base64');
          const rightBuf = Buffer.from(parsed.rightBase64 || '', 'base64');
          const left = new Float32Array(leftBuf.buffer, leftBuf.byteOffset, leftBuf.byteLength / 4);
          const right = new Float32Array(rightBuf.buffer, rightBuf.byteOffset, rightBuf.byteLength / 4);
          const outL = new Float32Array(left);
          const outR = new Float32Array(right);

          let totalLatencySamples = 0;
          for (const instId of parsed.instanceIds ?? []) {
            const inst = instances.get(instId);
            if (!inst) {
              res.writeHead(400, corsHeaders);
              res.end(JSON.stringify({ error: `Unknown instanceId: ${instId}` }));
              return;
            }
            if (inst.bypassed) continue;
            totalLatencySamples += inst.latencySamples;
            const db = (inst.gainNormalized - 0.5) * 48.0; // -24..+24 dB
            const gain = Math.pow(10, db / 20);
            for (let i = 0; i < outL.length; i++) {
              outL[i] *= gain;
              outR[i] *= gain;
            }
          }

          res.writeHead(200, corsHeaders);
          res.end(
            JSON.stringify({
              ok: true,
              sampleRate: parsed.sampleRate ?? 48000,
              samplesProcessed: outL.length,
              totalLatencySamples,
              durationMs: 1.25,
              leftBase64: Buffer.from(outL.buffer, outL.byteOffset, outL.byteLength).toString('base64'),
              rightBase64: Buffer.from(outR.buffer, outR.byteOffset, outR.byteLength).toString('base64'),
            }),
          );
        } catch {
          res.writeHead(400, corsHeaders);
          res.end(JSON.stringify({ error: 'Malformed audio payload' }));
        }
      });
      return;
    }

    res.writeHead(404, corsHeaders);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.on('upgrade', (req, socket: net.Socket) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (origin && !isAllowedOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const client: WsClient = {
      socket,
      authenticated: false,
      sendJson: (obj) => {
        if (!socket.destroyed) {
          socket.write(encodeWsFrame(JSON.stringify(obj)));
        }
      },
      closeWith: (code, reason) => {
        if (!socket.destroyed) {
          socket.write(encodeWsClose(code, reason));
          socket.end();
        }
      },
    };
    clients.add(client);

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return;

        let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          const unmasked = Buffer.alloc(len);
          for (let i = 0; i < len; i++) {
            unmasked[i] = payload[i] ^ mask[i % 4];
          }
          payload = unmasked;
        }
        buf = buf.subarray(offset + maskLen + len);

        if (opcode === 0x08) {
          socket.end();
          return;
        }
        if (opcode === 0x09) {
          socket.write(Buffer.from([0x8a, 0x00])); // pong
          continue;
        }
        if (opcode !== 0x01) continue;

        let msg: { id?: number; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          continue;
        }

        const id = msg.id;
        const method = msg.method || '';
        const params = msg.params || {};

        const allowed = new Set([
          'host.auth',
          'host.info',
          'catalog.list',
          'catalog.scan',
          'catalog.retryPlugin',
          'catalog.setPreference',
          'catalog.paths.list',
          'catalog.paths.add',
          'catalog.paths.remove',
          'catalog.history',
          'plugin.load',
          'plugin.unload',
          'plugin.listInstances',
          'plugin.setParameter',
          'plugin.getParameters',
          'plugin.setBypass',
          'plugin.getState',
          'plugin.setState',
          'plugin.openEditor',
          'plugin.closeEditor',
          'audio.devices',
          'audio.auditionStart',
          'audio.auditionStop',
          'audio.auditionStatus',
        ]);
        if (!allowed.has(method)) {
          client.sendJson({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not allowed' } });
          continue;
        }

        if (method === 'host.auth') {
          if (params.sessionToken === sessionToken) {
            client.authenticated = true;
            client.sendJson({ jsonrpc: '2.0', id, result: { authenticated: true, milestone: 2 } });
          } else {
            client.sendJson({ jsonrpc: '2.0', id, error: { code: 4001, message: 'Invalid session token' } });
            client.closeWith(4001, 'Invalid session token');
          }
          continue;
        }

        if (!client.authenticated) {
          client.sendJson({ jsonrpc: '2.0', id, error: { code: 4001, message: 'Unauthenticated' } });
          continue;
        }

        if (method === 'host.info') {
          const customRows = db.prepare('SELECT path FROM custom_directories').all() as Array<{ path: string }>;
          client.sendJson({
            jsonrpc: '2.0',
            id,
            result: {
              hostVersion: '0.2.0-test',
              os: 'windows-x64',
              milestone: 2,
              formatsSupported: ['vst3'],
              audioEngineActive: true,
              standardDirectories: ['C:\\Program Files\\Common Files\\VST3'],
              customDirectories: customRows.map((r) => r.path),
            },
          });
        } else if (method === 'catalog.list') {
          const plugins = listPlugins();
          client.sendJson({ jsonrpc: '2.0', id, result: { plugins, count: plugins.length } });
        } else if (method === 'catalog.history') {
          const history = db.prepare('SELECT * FROM scan_history ORDER BY id DESC LIMIT 25').all();
          client.sendJson({ jsonrpc: '2.0', id, result: { history } });
        } else if (method === 'catalog.paths.add') {
          const raw = String(params.path || '');
          if (!raw || raw.includes('..') || raw === '/' || /^c:\\?$/i.test(raw)) {
            client.sendJson({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Path traversal or root scan prohibited' } });
            continue;
          }
          db.prepare('INSERT OR IGNORE INTO custom_directories (path, added_at) VALUES (?, ?)').run(raw, Date.now());
          client.sendJson({ jsonrpc: '2.0', id, result: { added: raw } });
        } else if (method === 'catalog.paths.remove') {
          db.prepare('DELETE FROM custom_directories WHERE path = ?').run(String(params.path || ''));
          client.sendJson({ jsonrpc: '2.0', id, result: { removed: true } });
        } else if (method === 'catalog.setPreference') {
          const cur = db
            .prepare('SELECT favorite, disabled_by_user, last_used_at FROM plugins WHERE uid = ? AND bundle_path = ?')
            .get(String(params.uid), String(params.bundlePath)) as
            | { favorite: number; disabled_by_user: number; last_used_at: number }
            | undefined;
          if (cur) {
            db.prepare('UPDATE plugins SET favorite = ?, disabled_by_user = ?, last_used_at = ? WHERE uid = ? AND bundle_path = ?').run(
              typeof params.favorite === 'boolean' ? (params.favorite ? 1 : 0) : cur.favorite,
              typeof params.disabledByUser === 'boolean' ? (params.disabledByUser ? 1 : 0) : cur.disabled_by_user,
              typeof params.lastUsedAt === 'number' ? params.lastUsedAt : cur.last_used_at,
              String(params.uid),
              String(params.bundlePath),
            );
          }
          client.sendJson({ jsonrpc: '2.0', id, result: { updated: Boolean(cur) } });
        } else if (method === 'catalog.retryPlugin') {
          db.prepare("UPDATE plugins SET fail_count = 0, status = 'available', status_reason = 'Recovered on manual retry' WHERE uid = ? AND bundle_path = ?").run(
            String(params.uid),
            String(params.bundlePath),
          );
          client.sendJson({ jsonrpc: '2.0', id, result: { started: true } });
          client.sendJson({
            jsonrpc: '2.0',
            method: 'catalog.scanProgress',
            params: { completed: 1, total: 1, currentBundle: String(params.bundlePath), status: 'available' },
          });
        } else if (method === 'plugin.load') {
          const instanceId = `inst-${nextInstSeq++}`;
          const inst: MockInstance = {
            instanceId,
            pluginUid: String(params.uid || ''),
            pluginName: 'SYN Test Gain QA',
            bundlePath: String(params.bundlePath || ''),
            latencySamples: 64,
            hasEditor: true,
            editorOpen: false,
            bypassed: false,
            gainNormalized: 0.5,
            tiltNormalized: 0.5,
          };
          instances.set(instanceId, inst);
          client.sendJson({
            jsonrpc: '2.0',
            id,
            result: {
              instanceId: inst.instanceId,
              uid: inst.pluginUid,
              bundlePath: inst.bundlePath,
              name: inst.pluginName,
              manufacturer: 'SYN MASTER QA',
              sampleRate: Number(params.sampleRate ?? 48000),
              blockSize: Number(params.blockSize ?? 512),
              channels: Number(params.channels ?? 2),
              latencySamples: inst.latencySamples,
              bypassed: inst.bypassed,
              hasEditor: inst.hasEditor,
              editorOpen: inst.editorOpen,
              active: true,
              crashed: false,
              workerEngine: 'portable-qa-fixture',
              lastError: '',
              parameters: [
                { id: 0, name: 'Gain', label: 'dB', valueNormalized: inst.gainNormalized, defaultValueNormalized: 0.5, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false, displayValue: '0.0 dB' },
                { id: 1, name: 'High Tilt', label: 'dB', valueNormalized: inst.tiltNormalized, defaultValueNormalized: 0.5, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false, displayValue: '0.0 dB' },
              ],
            },
          });
        } else if (method === 'plugin.unload') {
          instances.delete(String(params.instanceId || ''));
          client.sendJson({ jsonrpc: '2.0', id, result: { unloaded: true } });
        } else if (method === 'plugin.listInstances') {
          client.sendJson({
            jsonrpc: '2.0',
            id,
            result: {
              instances: Array.from(instances.values()).map((inst) => ({
                instanceId: inst.instanceId,
                uid: inst.pluginUid,
                bundlePath: inst.bundlePath,
                name: inst.pluginName,
                manufacturer: 'SYN MASTER QA',
                sampleRate: 48000,
                blockSize: 512,
                channels: 2,
                latencySamples: inst.latencySamples,
                bypassed: inst.bypassed,
                hasEditor: inst.hasEditor,
                editorOpen: inst.editorOpen,
                active: true,
                crashed: false,
                workerEngine: 'portable-qa-fixture',
                lastError: '',
                parameters: [
                  { id: 0, name: 'Gain', label: 'dB', valueNormalized: inst.gainNormalized, defaultValueNormalized: 0.5, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false, displayValue: `${((inst.gainNormalized - 0.5) * 48).toFixed(1)} dB` },
                ],
              })),
            },
          });
        } else if (method === 'plugin.setParameter') {
          const inst = instances.get(String(params.instanceId || ''));
          if (!inst) {
            client.sendJson({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Instance not found' } });
            continue;
          }
          const val = Math.max(0, Math.min(1, Number(params.valueNormalized ?? 0.5)));
          const paramId = Number(params.paramId ?? 0);
          if (paramId === 0) inst.gainNormalized = val;
          else if (paramId === 1) inst.tiltNormalized = val;
          const displayValue = `${((val - 0.5) * 48).toFixed(1)} dB`;
          client.sendJson({ jsonrpc: '2.0', id, result: { instanceId: inst.instanceId, paramId, valueNormalized: val, displayValue } });
        } else if (method === 'plugin.setBypass') {
          const inst = instances.get(String(params.instanceId || ''));
          if (inst) inst.bypassed = Boolean(params.bypassed);
          client.sendJson({ jsonrpc: '2.0', id, result: { updated: Boolean(inst) } });
        } else if (method === 'plugin.getState') {
          const inst = instances.get(String(params.instanceId || ''));
          const stateStr = JSON.stringify({ gainNormalized: inst?.gainNormalized ?? 0.5, tiltNormalized: inst?.tiltNormalized ?? 0.5 });
          client.sendJson({ jsonrpc: '2.0', id, result: { stateBase64: Buffer.from(stateStr, 'utf8').toString('base64') } });
        } else if (method === 'plugin.setState') {
          const inst = instances.get(String(params.instanceId || ''));
          if (inst && typeof params.stateBase64 === 'string') {
            const parsed = JSON.parse(Buffer.from(params.stateBase64, 'base64').toString('utf8')) as {
              gainNormalized?: number;
              tiltNormalized?: number;
            };
            if (typeof parsed.gainNormalized === 'number') inst.gainNormalized = parsed.gainNormalized;
            if (typeof parsed.tiltNormalized === 'number') inst.tiltNormalized = parsed.tiltNormalized;
          }
          client.sendJson({ jsonrpc: '2.0', id, result: { restored: Boolean(inst) } });
        } else if (method === 'plugin.openEditor' || method === 'plugin.closeEditor') {
          const inst = instances.get(String(params.instanceId || ''));
          if (inst) inst.editorOpen = method === 'plugin.openEditor';
          client.sendJson({ jsonrpc: '2.0', id, result: { editorOpen: inst?.editorOpen ?? false } });
        } else if (method === 'audio.devices') {
          client.sendJson({
            jsonrpc: '2.0',
            id,
            result: {
              devices: [
                { id: 'wasapi-default', name: 'Speakers (WASAPI Test Device)', driverType: 'Windows Audio', sampleRates: [44100, 48000], isDefault: true },
              ],
            },
          });
        } else if (method === 'audio.auditionStart') {
          auditionActive = true;
          auditionSampleRate = Number(params.sampleRate ?? 48000);
          client.sendJson({ jsonrpc: '2.0', id, result: { active: true, sampleRate: auditionSampleRate, deviceId: String(params.deviceId || 'wasapi-default') } });
        } else if (method === 'audio.auditionStop') {
          auditionActive = false;
          client.sendJson({ jsonrpc: '2.0', id, result: { active: false } });
        } else if (method === 'audio.auditionStatus') {
          client.sendJson({ jsonrpc: '2.0', id, result: { active: auditionActive, sampleRate: auditionSampleRate } });
        } else if (method === 'catalog.scan') {
          client.sendJson({ jsonrpc: '2.0', id, result: { started: true } });
          const now = Date.now();
          if (currentScanScenario === 'initial') {
            upsertPluginRow({
              uid: 'vst3-test-eq-01',
              format: 'vst3',
              name: 'TestSuite Mastering EQ',
              manufacturer: 'Fixture DSP',
              version: '1.2.0',
              sdkVersion: 'VST3 3.8',
              category: 'Fx|EQ',
              subCategories: ['Fx', 'EQ'],
              bundlePath: 'C:\\Program Files\\Common Files\\VST3\\TestSuiteEQ.vst3',
              binaryPath: 'C:\\Program Files\\Common Files\\VST3\\TestSuiteEQ.vst3\\Contents\\x86_64-win\\TestSuiteEQ.vst3',
              arch: 'x64',
              status: 'available',
              statusReason: '',
              hasEditor: true,
              latencySamples: 64,
              busConfigs: [{ layoutName: 'Stereo', mainInputChannels: 2, mainOutputChannels: 2, sidechainInputChannels: 0 }],
              parameterCount: 2,
              parameters: [
                { id: 0, name: 'Low Shelf Freq', label: 'Hz', defaultValueNormalized: 0.25, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false },
                { id: 1, name: 'Bypass', label: '', defaultValueNormalized: 0, stepCount: 1, isAutomatable: true, isReadOnly: false, isBypass: true },
              ],
              fileHashSha256: 'hash-v1',
              lastScannedAt: now,
            });
            upsertPluginRow({
              uid: 'vst3-test-bad-02',
              format: 'vst3',
              name: 'UnstableLegacyComp',
              manufacturer: 'Fixture DSP',
              version: '0.9.0',
              sdkVersion: 'VST3',
              category: 'Fx|Dynamics',
              bundlePath: 'C:\\Program Files\\Common Files\\VST3\\UnstableLegacyComp.vst3',
              binaryPath: 'C:\\Program Files\\Common Files\\VST3\\UnstableLegacyComp.vst3',
              arch: 'x64',
              status: 'quarantined',
              statusReason: 'Scanner process crashed: STATUS_ACCESS_VIOLATION (0xC0000005)',
              failCount: 2,
              fileHashSha256: 'hash-bad',
              lastScannedAt: now,
            });
          } else {
            // Update EQ version + mark UnstableLegacyComp as missing
            upsertPluginRow({
              uid: 'vst3-test-eq-01',
              format: 'vst3',
              name: 'TestSuite Mastering EQ',
              manufacturer: 'Fixture DSP',
              version: '1.3.0',
              sdkVersion: 'VST3 3.8',
              category: 'Fx|EQ',
              bundlePath: 'C:\\Program Files\\Common Files\\VST3\\TestSuiteEQ.vst3',
              binaryPath: 'C:\\Program Files\\Common Files\\VST3\\TestSuiteEQ.vst3\\Contents\\x86_64-win\\TestSuiteEQ.vst3',
              arch: 'x64',
              status: 'available',
              latencySamples: 128,
              fileHashSha256: 'hash-v2',
              lastScannedAt: now,
            });
            db.prepare("UPDATE plugins SET status = 'missing', status_reason = 'Plugin bundle removed from disk' WHERE uid = ?").run('vst3-test-bad-02');
          }
          db.prepare(
            'INSERT INTO scan_history (started_at, finished_at, mode, total_bundles, discovered_plugins, failed_bundles, skipped_unchanged, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(now, now + 45, String(params.mode || 'incremental'), 2, 1, 1, 0, 'Test scan completed');
          client.sendJson({
            jsonrpc: '2.0',
            method: 'catalog.scanProgress',
            params: { completed: 2, total: 2, currentBundle: 'TestSuiteEQ.vst3', status: 'ok' },
          });
        }
      }
    });

    socket.on('close', () => {
      clients.delete(client);
    });
  });

  return {
    pairingCode,
    sessionToken,
    setScenario: (s: 'initial' | 'updated_and_missing') => {
      currentScanScenario = s;
    },
    dropAllSockets: () => {
      for (const c of clients) c.socket.destroy();
    },
    start: () =>
      new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as net.AddressInfo).port);
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.socket.destroy();
        server.close(() => resolve());
        db.close();
      }),
  };
}

test('Security: Rejects unauthorized Origins, bad pairing codes, unauthenticated/forbidden RPCs, and sets PNA headers', async () => {
  const host = createTestHostServer();
  const port = await host.start();
  try {
    // 1. Unauthorized Origin -> 403
    const evilHealth = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Origin: 'https://malicious.example.com' },
    });
    assert.equal(evilHealth.status, 403);

    // 2. HTTPS Cloud Run Origin PNA OPTIONS preflight -> 204 + Allow-Private-Network
    const pnaPreflight = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ais-dev-preview.us-west1.run.app',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(pnaPreflight.status, 204);
    assert.equal(pnaPreflight.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(
      pnaPreflight.headers.get('access-control-allow-origin'),
      'https://ais-dev-preview.us-west1.run.app',
    );

    // 3. Invalid pairing code -> 401
    const badPair = await fetch(`http://127.0.0.1:${port}/v1/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: JSON.stringify({ pairingCode: 'SYN-WRONG-CODE' }),
    });
    assert.equal(badPair.status, 401);

    // 4. WebSocket unauthenticated / out-of-scope method rejection
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let stage = 0;
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.list', params: {} }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (stage === 0) {
          assert.equal(msg.error.code, 4001);
          stage = 1;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'audio.processBlock', params: {} }));
        } else if (stage === 1) {
          assert.equal(msg.error.code, -32601);
          ws.close();
          resolve();
        }
      };
      ws.onerror = () => reject(new Error('WS unexpected error'));
    });
  } finally {
    await host.stop();
  }
});

test('SynHostBridge: Quiet boot, pairing, SQLite catalog scan/update/missing/no-duplicates, preferences, traversal block, and disconnect', async () => {
  const host = createTestHostServer();
  const port = await host.start();
  const bridge = new SynHostBridge(port);

  try {
    // 1. Quiet browser-only initial state without network calls
    assert.equal(bridge.getSnapshot().status, 'browser-only');
    assert.equal(bridge.getSnapshot().plugins.length, 0);

    // 2. Pair and connect
    const ok = await bridge.connectAndPair({ hostPort: port, pairingCode: host.pairingCode });
    assert.equal(ok, true);
    assert.equal(bridge.getSnapshot().status, 'connected');
    assert.equal(bridge.getSnapshot().hostInfo?.milestone, 2);

    // 3. Initial scan & SQLite persistence
    await bridge.triggerScan('incremental');
    // Triggering async notification + refresh
    await new Promise((r) => setTimeout(r, 80));
    await bridge.refreshCatalogAndHistory();
    let snap = bridge.getSnapshot();
    assert.equal(snap.plugins.length, 2);
    const eq = snap.plugins.find((p) => p.uid === 'vst3-test-eq-01');
    const bad = snap.plugins.find((p) => p.uid === 'vst3-test-bad-02');
    assert.ok(eq && eq.status === 'available' && eq.parameterCount === 2);
    assert.ok(bad && bad.status === 'quarantined' && bad.failCount === 2);

    // 4. Retry quarantined plugin
    await bridge.retryPlugin(bad.uid, bad.bundlePath);
    await bridge.refreshCatalogAndHistory();
    snap = bridge.getSnapshot();
    assert.equal(snap.plugins.find((p) => p.uid === bad.uid)?.status, 'available');

    // 5. Preferences (favorite + disabledByUser)
    await bridge.setPluginPreference(eq.uid, eq.bundlePath, { favorite: true, disabledByUser: true });
    snap = bridge.getSnapshot();
    const updatedEq = snap.plugins.find((p) => p.uid === eq.uid)!;
    assert.equal(updatedEq.favorite, true);
    assert.equal(updatedEq.disabledByUser, true);

    // 6. Path traversal rejection & valid custom path add
    await assert.rejects(() => bridge.addCustomDirectory('C:\\VST3\\..\\..\\Windows'), /traversal/i);
    await bridge.addCustomDirectory('C:\\Audio\\CustomVST3');
    assert.ok(bridge.getSnapshot().hostInfo?.customDirectories.includes('C:\\Audio\\CustomVST3'));

    // 7. Rescan with updated version + missing bundle -> zero duplicate entries
    host.setScenario('updated_and_missing');
    await bridge.triggerScan('full');
    await new Promise((r) => setTimeout(r, 80));
    await bridge.refreshCatalogAndHistory();
    snap = bridge.getSnapshot();
    assert.equal(snap.plugins.length, 2, 'Catalog must not contain duplicate entries after rescan');
    assert.equal(snap.plugins.find((p) => p.uid === eq.uid)?.version, '1.3.0');
    assert.equal(snap.plugins.find((p) => p.uid === bad.uid)?.status, 'missing');

    // 8. Host socket drop -> disconnected
    host.dropAllSockets();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(bridge.getSnapshot().status, 'disconnected');

    // 9. Clean manual disconnect returns to browser-only with empty catalog
    bridge.disconnect();
    assert.equal(bridge.getSnapshot().status, 'browser-only');
    assert.equal(bridge.getSnapshot().plugins.length, 0);
  } finally {
    bridge.disconnect();
    await host.stop();
  }
});

test('Out-of-process child worker isolation: Host survives child crash and child timeout kill', async () => {
  async function runIsolatedWorker(script: string, timeoutMs: number): Promise<{ crashed: boolean; timedOut: boolean; code: number | null; signal: string | null }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({
          crashed: !timedOut && (signal !== null || (code !== null && code !== 0)),
          timedOut,
          code,
          signal,
        });
      });
    });
  }

  // Simulated crashing plugin binary
  const crashRes = await runIsolatedWorker('process.abort()', 2000);
  assert.equal(crashRes.crashed, true);
  assert.equal(crashRes.timedOut, false);

  // Simulated hanging plugin initializer killed on timeout
  const hangRes = await runIsolatedWorker('setInterval(() => {}, 1000)', 150);
  assert.equal(hangRes.timedOut, true);
  assert.equal(hangRes.signal, 'SIGKILL');
  // Dummy reference to path keeps import clean if expanded later
  assert.ok(path.isAbsolute(process.execPath));
});

test('Milestone 2: Plugin instance lifecycle, Float32 Base64 audio processing, Bearer enforcement, state save/restore, and WASAPI RPCs', async () => {
  // 1. Float32Array Base64 roundtrip codec fidelity
  const original = new Float32Array([0, 0.25, -0.5, 0.9995, -0.12345]);
  const decoded = decodeFloat32ArrayBase64(encodeFloat32ArrayBase64(original));
  assert.equal(decoded.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(decoded[i] - original[i]) < 1e-7);
  }

  const host = createTestHostServer();
  const port = await host.start();
  const bridge = new SynHostBridge(port);

  try {
    // 2. Reject HTTP /v1/audio/process-offline without valid Bearer token (401)
    const unauthHttp = await fetch(`http://127.0.0.1:${port}/v1/audio/process-offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: JSON.stringify({ instanceIds: [], sampleRate: 48000, leftBase64: '', rightBase64: '' }),
    });
    assert.equal(unauthHttp.status, 401);

    // 3. Pair & check WASAPI device reporting
    assert.equal(await bridge.connectAndPair({ hostPort: port, pairingCode: host.pairingCode }), true);
    const devices = await bridge.refreshAudioDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, 'wasapi-default');

    // 4. Load plugin instance, set gain to +6 dB (normalized 0.625 => +6.0 dB)
    const inst = await bridge.loadPluginInstance({
      uid: 'builtin.qa.gain',
      bundlePath: 'C:\\Program Files\\Common Files\\VST3\\syn_test_vst3_gain.vst3',
      sampleRate: 48000,
      blockSize: 512,
      channels: 2,
    });
    assert.equal(inst.active, true);
    assert.equal(inst.latencySamples, 64);

    const paramRes = await bridge.setPluginParameter(inst.instanceId, 0, 0.625);
    assert.equal(paramRes.displayValue, '6.0 dB');

    // 5. Process stereo buffer via HTTP /v1/audio/process-offline
    const n = 1024;
    const inL = new Float32Array(n).fill(0.2);
    const inR = new Float32Array(n).fill(-0.2);
    const procRes = await bridge.processAudioOffline([inst.instanceId], 48000, [inL, inR]);
    assert.equal(procRes.totalLatencySamples, 64);
    const expectedAmp = 0.2 * Math.pow(10, 6 / 20);
    assert.ok(Math.abs(procRes.channels[0][0] - expectedAmp) < 1e-4);
    assert.ok(Math.abs(procRes.channels[1][0] + expectedAmp) < 1e-4);

    // 6. Bypass toggle -> bit-identical pass-through & zero latency contribution
    await bridge.setPluginBypass(inst.instanceId, true);
    const bpRes = await bridge.processAudioOffline([inst.instanceId], 48000, [inL, inR]);
    assert.equal(bpRes.totalLatencySamples, 0);
    assert.equal(bpRes.channels[0][0], inL[0]);
    await bridge.setPluginBypass(inst.instanceId, false);

    // 7. Save state, change parameter, restore state, confirm +6dB returns
    const savedB64 = await bridge.getPluginState(inst.instanceId);
    assert.ok(savedB64.length > 0);
    await bridge.setPluginParameter(inst.instanceId, 0, 0.5); // back to 0 dB
    const zeroDbRes = await bridge.processAudioOffline([inst.instanceId], 48000, [inL, inR]);
    assert.ok(Math.abs(zeroDbRes.channels[0][0] - 0.2) < 1e-5);

    await bridge.setPluginState(inst.instanceId, savedB64);
    const restoredRes = await bridge.processAudioOffline([inst.instanceId], 48000, [inL, inR]);
    assert.ok(Math.abs(restoredRes.channels[0][0] - expectedAmp) < 1e-4);

    // 8. Native editor toggle + WASAPI audition start/stop + unload
    await bridge.openPluginEditor(inst.instanceId);
    await bridge.closePluginEditor(inst.instanceId);
    const audStart = await bridge.startWasapiAudition([inL, inR], 48000, 'wasapi-default', true);
    assert.equal(audStart.active, true);
    await bridge.stopWasapiAudition();
    assert.equal(bridge.getSnapshot().auditionStatus?.active, false);

    await bridge.unloadPluginInstance(inst.instanceId);
    assert.equal(bridge.getSnapshot().instances.length, 0);
  } finally {
    bridge.disconnect();
    await host.stop();
  }
});
