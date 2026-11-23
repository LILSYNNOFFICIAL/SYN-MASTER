/**
 * Headless Fix-All runner (dev tool, not part of the web app bundle).
 *
 *   npx tsx scripts/headless-master.ts <input audio> [objectiveId] [out.wav]
 *
 * Decodes the file with ffmpeg to 32-bit float, runs the same analysis and
 * runAutonomousDirectorLoop the "FIX IT ALL WITH AI" button runs (deterministic engine,
 * no Gemini), renders the retained chain offline and writes the master as 32-bit float
 * WAV so it can be checked independently (ffmpeg ebur128 / astats, a click scan).
 * Prints a JSON summary of before/after measurements and the gate verdict.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { analyzeAudioBuffer } from '../src/dsp/analyzer';
import { processChainOffline } from '../src/dsp/offlineDsp';
import { runAutonomousDirectorLoop } from '../src/director/directorEngine';
import { analyzeTrackIntelligence } from '../src/director/analyzeIntelligence';
import type { MasteringObjectiveId } from '../src/types/mastering';

function probe(path: string, entry: string): number {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', `stream=${entry}`, '-of', 'csv=p=0', path], { encoding: 'utf8' });
  return Number(String(r.stdout).trim());
}

function decode(path: string): { channels: Float32Array[]; sampleRate: number } {
  const sampleRate = probe(path, 'sample_rate');
  const ch = Math.min(2, probe(path, 'channels') || 2);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', String(ch), '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 2 ** 31 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const buf = r.stdout as Buffer;
  const inter = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = Math.floor(inter.length / ch);
  const channels = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) channels[c][i] = inter[i * ch + c];
  return { channels, sampleRate };
}

function writeWavFloat(path: string, channels: Float32Array[], sampleRate: number) {
  const ch = channels.length;
  const n = channels[0].length;
  const data = Buffer.alloc(n * ch * 4);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) data.writeFloatLE(channels[c][i], (i * ch + c) * 4);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * ch * 4, 28); h.writeUInt16LE(ch * 4, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

const pick = (a: ReturnType<typeof analyzeAudioBuffer>) => ({
  lufs: Number(a.integratedLufs.toFixed(2)),
  truePeakDb: Number(a.truePeakDb.toFixed(2)),
  lraLu: Number(a.loudnessRangeLu.toFixed(1)),
  drDb: Number(a.dynamicRangeDb.toFixed(1)),
  crestDb: Number(a.crestFactorDb.toFixed(1)),
  clippedSamples: a.clippedSamples,
  clicks: a.clickCount ?? 0,
  clickTimesSec: (a as { clickTimesSec?: number[] }).clickTimesSec?.slice(0, 12),
  dcOffset: Number(a.dcOffset.toFixed(5)),
  phase: Number(a.phaseCorrelation.toFixed(2)),
  lowEndPhase: Number(a.lowEndCorrelation.toFixed(2)),
});

async function main() {
  const [input, objectiveArg, outArg] = process.argv.slice(2);
  if (!input) throw new Error('usage: headless-master.ts <input> [objectiveId] [out.wav]');
  const objectiveId = (objectiveArg || 'streaming') as MasteringObjectiveId;
  const t0 = Date.now();
  const { channels, sampleRate } = decode(input);
  const pre = analyzeAudioBuffer(channels, sampleRate);
  const diag = analyzeTrackIntelligence(pre, objectiveId);
  const log: string[] = [];
  const report = await runAutonomousDirectorLoop({
    sourceChannels: channels,
    sampleRate,
    operatingMode: 'autonomous',
    objectiveId,
    maxIterations: 10,
    maxCpuBudgetMs: 600_000,
    onProgress: (u) => { if (u.activityEntry) log.push(`[p${u.passNumber}] ${u.activityEntry.message}`); },
  });
  const rendered = processChainOffline(channels, sampleRate, report.finalChain);
  const out = outArg || input.replace(/\.[^.]+$/, '') + '.syn-master.wav';
  writeWavFloat(out, rendered.channels, sampleRate);
  const post = analyzeAudioBuffer(rendered.channels, sampleRate);
  console.log(JSON.stringify({
    input, objectiveId, sampleRate, seconds: Number((channels[0].length / sampleRate).toFixed(2)),
    target: { lufs: report.objective.targetLufs, maxTruePeakDb: report.objective.maxTruePeakDb },
    before: pick(pre),
    findingsBefore: diag.findings.map((f) => `${f.id} (${f.severity}): ${f.title ?? ''}`),
    status: report.status,
    stopReason: report.stopReason,
    passes: report.iterationsExecuted,
    bestPass: report.bestPassNumber,
    gatePassed: report.targetGate?.passed,
    gateFailed: report.targetGate?.failed.map((c) => `${c.label}: ${c.measured} (target ${c.target})`),
    chain: report.finalChain.filter((m) => m.enabled && !m.bypassed).map((m) => m.type),
    afterReported: pick(report.postAnalysis),
    afterReRendered: pick(post),
    outFile: out,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    activity: log,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
