import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const TEST_TIMEOUT_MS = 240_000;
const MAX_BUFFER = 32 * 1024 * 1024;

async function commandAvailable(command) {
  try {
    await execFile(command, ['-version'], { maxBuffer: MAX_BUFFER, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
  commandAvailable('ffmpeg'),
  commandAvailable('ffprobe'),
]);
const exportToolSkip = ffmpegAvailable && ffprobeAvailable
  ? false
  : 'FFmpeg and/or ffprobe are not installed on PATH';

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local test port.');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function createFloatWav(sampleRate, durationSeconds = 3) {
  const channels = 2;
  const frames = Math.round(sampleRate * durationSeconds);
  const dataBytes = frames * channels * 4;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20); // IEEE float
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 4, 28);
  wav.writeUInt16LE(channels * 4, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);

  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate;
    const envelope = 0.20 + 0.055 * Math.sin(2 * Math.PI * 0.37 * time);
    const left = envelope * (
      0.62 * Math.sin(2 * Math.PI * 440 * time) +
      0.20 * Math.sin(2 * Math.PI * 93 * time) +
      0.08 * Math.sin(2 * Math.PI * 7200 * time)
    );
    const right = envelope * (
      0.60 * Math.sin(2 * Math.PI * 440 * time + 0.11) +
      0.19 * Math.sin(2 * Math.PI * 659.25 * time) +
      0.08 * Math.sin(2 * Math.PI * 6100 * time)
    );
    const offset = 44 + frame * channels * 4;
    wav.writeFloatLE(left, offset);
    wav.writeFloatLE(right, offset + 4);
  }
  return wav;
}

async function waitForEndpoint(baseUrl, child, getDiagnostics) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('SYN-MASTER test server exited early. ' + getDiagnostics());
    try {
      const response = await fetch(baseUrl + '/api/export/encode?format=invalid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Origin: baseUrl },
        body: Buffer.alloc(44),
      });
      if (response.status === 400) return;
    } catch {
      // The server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('SYN-MASTER export endpoint did not become ready. ' + getDiagnostics());
}

async function exportAudio(baseUrl, fixture, format, sampleRate = 48000, options = {}) {
  const params = new URLSearchParams({
    format,
    sampleRate: String(sampleRate),
    channels: 'stereo',
    wavBitDepth: '24',
    flacBitDepth: '24',
    flacCompression: '5',
    mp3BitrateKbps: '320',
    dither: 'none',
    ceilingDb: String(options.ceilingDb ?? -1),
    normalizeToTarget: String(options.normalizeToTarget ?? false),
    targetLufs: String(options.targetLufs ?? -14),
  });
  const response = await fetch(baseUrl + '/api/export/encode?' + params.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fixture,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, format + ' export failed: ' + bytes.toString('utf8').slice(0, 1000));
  assert.ok(bytes.length > 44, format + ' export returned an empty or truncated file.');
  const expectedMime = format === 'wav' ? 'audio/wav' : format === 'flac' ? 'audio/flac' : 'audio/mpeg';
  assert.ok(response.headers.get('content-type')?.startsWith(expectedMime), format + ' response has an incorrect MIME type.');
  const integratedLufs = Number(response.headers.get('X-Syn-Integrated-Lufs'));
  const truePeakDbtp = Number(response.headers.get('X-Syn-True-Peak-Dbtp'));
  assert.ok(Number.isFinite(integratedLufs), format + ' response is missing its encoded-file integrated LUFS measurement.');
  assert.ok(Number.isFinite(truePeakDbtp), format + ' response is missing its encoded-file true-peak measurement.');
  assert.equal(response.headers.get('X-Syn-Over-Ceiling'), '0', format + ' output exceeded the requested -1 dBTP ceiling.');
  return { bytes, integratedLufs, truePeakDbtp };
}

async function probeAudio(filePath) {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate,bits_per_sample,bits_per_raw_sample',
    '-of', 'json', filePath,
  ], { maxBuffer: MAX_BUFFER, encoding: 'utf8' });
  const stream = JSON.parse(stdout).streams?.[0];
  assert.ok(stream, 'ffprobe found no audio stream in ' + filePath);
  return stream;
}

async function measureIntegratedLufs(filePath) {
  const { stderr } = await execFile('ffmpeg', [
    '-hide_banner', '-nostats', '-i', filePath, '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { maxBuffer: MAX_BUFFER, encoding: 'utf8' });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const match = summary.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  assert.ok(match && match[1] !== '-inf', 'FFmpeg could not measure integrated loudness for ' + filePath);
  return Number(match[1]);
}

async function decodeToS32(filePath, outputPath) {
  await execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', filePath,
    '-f', 's32le', '-acodec', 'pcm_s32le', '-ar', '48000', '-ac', '2', outputPath,
  ], { maxBuffer: MAX_BUFFER, encoding: 'utf8' });
  return readFile(outputPath);
}

test('SYN-MASTER export endpoint creates measurable contract-format files', { timeout: TEST_TIMEOUT_MS, skip: exportToolSkip }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'syn-master-export-test-'));
  const port = await getFreePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  const collect = (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-12_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
        timer.unref?.();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForEndpoint(baseUrl, child, () => diagnostics);

  const crossOrigin = await fetch(baseUrl + '/api/export/encode?format=wav', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://attacker.example' },
    body: Buffer.alloc(44),
  });
  assert.equal(crossOrigin.status, 403, 'Cross-origin browser uploads must be rejected.');

  const oversizedStatus = await new Promise((resolve, reject) => {
    let responseStarted = false;
    const request = httpRequest(baseUrl + '/api/export/encode?format=wav', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Origin: baseUrl,
        'Content-Length': String(512 * 1024 * 1024 + 1),
      },
    }, (response) => {
      responseStarted = true;
      response.resume();
      response.on('end', () => {
        request.destroy();
        resolve(response.statusCode);
      });
    });
    request.on('error', (error) => { if (!responseStarted) reject(error); });
    request.flushHeaders();
  });
  assert.equal(oversizedStatus, 413, 'Declared uploads over 512 MiB must be rejected before buffering.');

  const invalidCeiling = await fetch(baseUrl + '/api/export/encode?format=wav&ceilingDb=0', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Origin: baseUrl },
    body: Buffer.alloc(44),
  });
  assert.equal(invalidCeiling.status, 400, 'A 0 dB export ceiling must be rejected.');

  const invalidLoudness = await fetch(baseUrl + '/api/export/encode?format=wav&normalizeToTarget=true&targetLufs=-25', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Origin: baseUrl },
    body: Buffer.alloc(44),
  });
  assert.equal(invalidLoudness.status, 400, 'A target outside the supported loudness range must be rejected.');

  const pendingExports = [1, 2].map(() => {
    const request = httpRequest(baseUrl + '/api/export/encode?format=wav&sampleRate=48000', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Origin: baseUrl,
        'Content-Length': String(512 * 1024 * 1024),
      },
    });
    request.on('error', () => {});
    request.flushHeaders();
    return request;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fetch(baseUrl + '/api/health');
  const queuedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(baseUrl + '/api/export/encode?format=wav', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Origin: baseUrl, 'Content-Length': '0' },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(queuedStatus, 503, 'A third concurrent export must be rejected while two uploads are active.');
  pendingExports.forEach((request) => request.destroy());
  await new Promise((resolve) => setTimeout(resolve, 100));
  const source48 = createFloatWav(48000);
  const source48Path = path.join(tempDir, 'source-48000-float.wav');
  await writeFile(source48Path, source48);
  const sourceLufs = await measureIntegratedLufs(source48Path);

  const wav48 = await exportAudio(baseUrl, source48, 'wav', 48000);
  const flac48 = await exportAudio(baseUrl, source48, 'flac', 48000);
  const mp348 = await exportAudio(baseUrl, source48, 'mp3', 48000);
  const wav48Path = path.join(tempDir, 'master-48000.wav');
  const flac48Path = path.join(tempDir, 'master-48000.flac');
  const mp348Path = path.join(tempDir, 'master-48000.mp3');
  await Promise.all([
    writeFile(wav48Path, wav48.bytes),
    writeFile(flac48Path, flac48.bytes),
    writeFile(mp348Path, mp348.bytes),
  ]);

  const wavInfo = await probeAudio(wav48Path);
  assert.equal(wavInfo.codec_name, 'pcm_s24le');
  assert.equal(Number(wavInfo.sample_rate), 48000);
  assert.equal(Number(wavInfo.channels), 2);
  assert.equal(Number(wavInfo.bits_per_raw_sample), 24);

  const flacInfo = await probeAudio(flac48Path);
  assert.equal(flacInfo.codec_name, 'flac');
  assert.equal(Number(flacInfo.sample_rate), 48000);
  assert.equal(Number(flacInfo.channels), 2);
  assert.equal(Number(flacInfo.bits_per_raw_sample), 24);

  const mp3Info = await probeAudio(mp348Path);
  assert.equal(mp3Info.codec_name, 'mp3');
  assert.equal(Number(mp3Info.sample_rate), 48000);
  assert.equal(Number(mp3Info.channels), 2);
  assert.equal(Number(mp3Info.bit_rate), 320000);

  assert.ok(Math.abs(wav48.integratedLufs - sourceLufs) <= 0.10,
    'Default WAV export changed integrated loudness despite normalization being disabled.');
  assert.ok(Math.abs(flac48.integratedLufs - sourceLufs) <= 0.10,
    'Default FLAC export changed integrated loudness despite normalization being disabled.');
  assert.ok(Math.abs(mp348.integratedLufs - sourceLufs) <= 0.80,
    '320 kbps MP3 export changed integrated loudness more than the lossy-codec tolerance.');

  const normalizedWav = await exportAudio(baseUrl, source48, 'wav', 48000, {
    normalizeToTarget: true,
    targetLufs: -14,
    ceilingDb: -1,
  });
  const normalizedPath = path.join(tempDir, 'normalized-minus-14.wav');
  await writeFile(normalizedPath, normalizedWav.bytes);
  const normalizedLufs = await measureIntegratedLufs(normalizedPath);
  assert.ok(Math.abs(normalizedLufs - (-14)) <= 1.0,
    'Opt-in loudness normalization did not reach the requested -14 LUFS target.');

  const wavDecoded = await decodeToS32(wav48Path, path.join(tempDir, 'wav-48k.s32le'));
  const flacDecoded = await decodeToS32(flac48Path, path.join(tempDir, 'flac-48k.s32le'));
  assert.equal(Buffer.compare(wavDecoded, flacDecoded), 0,
    '24-bit WAV and FLAC decoded samples differ with dither disabled.');

  const source44 = createFloatWav(44100);
  const wav44 = await exportAudio(baseUrl, source44, 'wav', 48000);
  const flac44 = await exportAudio(baseUrl, source44, 'flac', 48000);
  const wav44Path = path.join(tempDir, 'resampled-48000.wav');
  const flac44Path = path.join(tempDir, 'resampled-48000.flac');
  await Promise.all([writeFile(wav44Path, wav44.bytes), writeFile(flac44Path, flac44.bytes)]);
  const wav44Info = await probeAudio(wav44Path);
  const flac44Info = await probeAudio(flac44Path);
  assert.equal(Number(wav44Info.sample_rate), 48000, '44.1 kHz input was not resampled to 48 kHz WAV.');
  assert.equal(Number(flac44Info.sample_rate), 48000, '44.1 kHz input was not resampled to 48 kHz FLAC.');
  assert.equal(Number(wav44Info.bits_per_raw_sample), 24);
  assert.equal(Number(flac44Info.bits_per_raw_sample), 24);
  const wav44Decoded = await decodeToS32(wav44Path, path.join(tempDir, 'wav-44-to-48.s32le'));
  const flac44Decoded = await decodeToS32(flac44Path, path.join(tempDir, 'flac-44-to-48.s32le'));
  assert.equal(Buffer.compare(wav44Decoded, flac44Decoded), 0,
    'Resampled 24-bit WAV and FLAC decoded samples differ with dither disabled.');
});

/** 48 kHz stereo float WAV: a steady tone with a linear fade-in and fade-out baked in. */
function createFadedFloatWav(sampleRate, durationSeconds, fadeSeconds) {
  const channels = 2;
  const frames = Math.round(sampleRate * durationSeconds);
  const fadeN = Math.round(sampleRate * fadeSeconds);
  const dataBytes = frames * channels * 4;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 4, 28);
  wav.writeUInt16LE(channels * 4, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const gain = i < fadeN ? i / fadeN : i >= frames - fadeN ? (frames - 1 - i) / fadeN : 1;
    samples[i] = 0.25 * gain * Math.sin(2 * Math.PI * 440 * (i / sampleRate));
    wav.writeFloatLE(samples[i], 44 + i * 8);
    wav.writeFloatLE(samples[i], 44 + i * 8 + 4);
  }
  return { wav, samples, fadeN, frames };
}

function windowPeak(buf, from, to) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(buf.readInt32LE(i * 8) / 2147483648));
  return m;
}

test('normalized export keeps timeline fades intact (one constant gain, no AGC)', { timeout: TEST_TIMEOUT_MS, skip: exportToolSkip }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'syn-master-fade-export-'));
  const port = await getFreePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  const collect = (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-12_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
        timer.unref?.();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  });
  await waitForEndpoint(baseUrl, child, () => diagnostics);

  const SR = 48000;
  const { wav, frames, fadeN } = createFadedFloatWav(SR, 12, 3);
  const params = new URLSearchParams({
    format: 'wav', sampleRate: String(SR), channels: 'stereo', wavBitDepth: '32', dither: 'none',
    ceilingDb: '-1', normalizeToTarget: 'true', targetLufs: '-14', preserveFades: 'true',
  });
  const response = await fetch(baseUrl + '/api/export/encode?' + params.toString(), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wav,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, 'fade-safe export failed: ' + bytes.toString('utf8').slice(0, 500));
  assert.equal(response.headers.get('X-Syn-Over-Ceiling'), '0', 'fade-safe normalization must respect the ceiling');
  const outPath = path.join(tempDir, 'faded.wav');
  await writeFile(outPath, bytes);
  const decoded = await decodeToS32(outPath, path.join(tempDir, 'faded.s32le'));
  assert.equal(decoded.length / 8, frames, 'every frame is exported');

  // A constant gain keeps the fade shape: each window's level relative to the steady
  // middle equals the fade gain at that point (a dynamic AGC would lift the fade regions).
  const win = Math.round(SR * 0.05);
  const steady = windowPeak(decoded, Math.round(SR * 5), Math.round(SR * 5) + win);
  assert.ok(steady > 0.05, 'steady section is audible after normalization');
  for (const frac of [0.1, 0.25, 0.5, 0.75]) {
    const start = Math.round(fadeN * frac);
    const expectedIn = (start + win) / fadeN;
    const relIn = windowPeak(decoded, start, start + win) / steady;
    assert.ok(Math.abs(relIn - expectedIn) < 0.03, `fade-in at ${frac}: level ${relIn.toFixed(3)} vs fade gain ${expectedIn.toFixed(3)}`);
    const outStart = frames - fadeN + Math.round(fadeN * frac);
    const expectedOut = (frames - 1 - outStart) / fadeN;
    const relOut = windowPeak(decoded, outStart, outStart + win) / steady;
    assert.ok(Math.abs(relOut - expectedOut) < 0.03, `fade-out at ${frac}: level ${relOut.toFixed(3)} vs fade gain ${expectedOut.toFixed(3)}`);
  }
  assert.equal(decoded.readInt32LE(0), 0, 'fade-in starts at true silence');
  assert.equal(decoded.readInt32LE((frames - 1) * 8), 0, 'fade-out ends at true silence');
});
