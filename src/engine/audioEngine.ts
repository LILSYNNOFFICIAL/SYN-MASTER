import type {
  BassEnhancerParams,
  CompressorParams,
  DynamicEQParams,
  LimiterParams,
  MaximizerParams,
  MultibandCompParams,
  ParametricEQParams,
  ProcessorModule,
  RestoreParams,
  SaturationParams,
  StereoImagerParams,
} from '../types/mastering';
import { dbToLinear, linearToDb } from '../dsp/analyzer';

export type AuditionTarget =
  | 'mastered'
  | 'original'
  | 'reference'
  | 'candidate-a'
  | 'candidate-b'
  | 'candidate-c'
  | 'iteration';

export interface LiveMeterSnapshot {
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
  correlation: number;
  gainReductionDb: number;
  fftBins: Uint8Array;
  timeDomainL: Float32Array;
  timeDomainR: Float32Array;
}

/**
 * SYN-ENGINE: Real-time Web Audio API playback, live modular DSP routing,
 * A/B comparison, loop regions, and real-time stereo/spectrum telemetry.
 */
export class SynAudioEngine {
  private ctx: AudioContext | null = null;
  private sourceBuffer: AudioBuffer | null = null;
  private referenceBuffer: AudioBuffer | null = null;
  private overrideBuffers = new Map<string, AudioBuffer>();

  private activeSourceNode: AudioBufferSourceNode | null = null;
  private chainInputGain: GainNode | null = null;
  private chainOutputGain: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private analyserMain: AnalyserNode | null = null;
  private compressorMonitors: DynamicsCompressorNode[] = [];

  private activeChainNodes: AudioNode[] = [];
  private isPlaying = false;
  private startedAtCtxTime = 0;
  private pauseOffsetSec = 0;
  private playbackRate = 1.0;
  private loopEnabled = false;
  private loopStartSec = 0;
  private loopEndSec = 0;

  private monitorVolume = 0.85;
  private auditionTarget: AuditionTarget = 'mastered';
  private loudnessTrimGainDb = 0;
  private currentChain: ProcessorModule[] = [];
  private chainBypassed = false;
  private onEndedCallback?: () => void;

  private tdBufL = new Float32Array(1024);
  private tdBufR = new Float32Array(1024);
  private fftBuf = new Uint8Array(1024);

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.chainInputGain = this.ctx.createGain();
      this.chainOutputGain = this.ctx.createGain();
      this.monitorGain = this.ctx.createGain();
      this.monitorGain.gain.value = this.monitorVolume;

      this.analyserMain = this.ctx.createAnalyser();
      this.analyserMain.fftSize = 2048;
      this.analyserMain.smoothingTimeConstant = 0.72;
      this.fftBuf = new Uint8Array(this.analyserMain.frequencyBinCount);

      this.splitter = this.ctx.createChannelSplitter(2);
      this.analyserL = this.ctx.createAnalyser();
      this.analyserL.fftSize = 1024;
      this.analyserR = this.ctx.createAnalyser();
      this.analyserR.fftSize = 1024;

      this.chainOutputGain.connect(this.monitorGain);
      this.monitorGain.connect(this.analyserMain);
      this.analyserMain.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
      this.monitorGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public async decodeFile(file: File): Promise<{
    buffer: AudioBuffer;
    channels: Float32Array[];
    sampleRate: number;
  }> {
    const ctx = this.ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < Math.min(2, decoded.numberOfChannels); ch++) {
      channels.push(new Float32Array(decoded.getChannelData(ch)));
    }
    if (channels.length === 1) {
      channels.push(new Float32Array(channels[0]));
    }
    return { buffer: decoded, channels, sampleRate: decoded.sampleRate };
  }

  public createAudioBufferFromChannels(
    channels: Float32Array[],
    sampleRate: number,
  ): AudioBuffer {
    const ctx = this.ensureContext();
    const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
    for (let ch = 0; ch < channels.length; ch++) {
      buf.getChannelData(ch).set(channels[ch]);
    }
    return buf;
  }

  public setSourceChannels(channels: Float32Array[], sampleRate: number): void {
    this.stop();
    this.sourceBuffer = this.createAudioBufferFromChannels(channels, sampleRate);
    this.pauseOffsetSec = 0;
    this.loopStartSec = 0;
    this.loopEndSec = this.sourceBuffer.duration;
  }

  public setReferenceChannels(channels: Float32Array[], sampleRate: number): void {
    this.referenceBuffer = this.createAudioBufferFromChannels(channels, sampleRate);
  }

  public setOverrideBuffer(key: string, channels: Float32Array[], sampleRate: number): void {
    this.overrideBuffers.set(key, this.createAudioBufferFromChannels(channels, sampleRate));
    if (key === 'mastered-external' && this.auditionTarget === 'mastered') {
      if (this.isPlaying && !this.chainBypassed) {
        // Hot-swap to the freshly verified render at the current position.
        this.play(this.getCurrentTimeSec());
      } else {
        this.rebuildLiveGraph();
      }
    }
  }

  public clearOverrideBuffer(key: string): void {
    const had = this.overrideBuffers.delete(key);
    if (had && key === 'mastered-external' && this.auditionTarget === 'mastered') {
      this.rebuildLiveGraph();
    }
  }

  public setOnEnded(cb: () => void): void {
    this.onEndedCallback = cb;
  }

  public setMonitorVolume(val01: number): void {
    this.monitorVolume = Math.max(0, Math.min(1.25, val01));
    if (this.monitorGain && this.ctx) {
      this.monitorGain.gain.setTargetAtTime(this.monitorVolume, this.ctx.currentTime, 0.015);
    }
  }

  public setLoudnessTrimDb(db: number): void {
    this.loudnessTrimGainDb = Math.max(-18, Math.min(18, db));
    if (this.chainOutputGain && this.ctx) {
      this.chainOutputGain.gain.setTargetAtTime(
        dbToLinear(this.loudnessTrimGainDb),
        this.ctx.currentTime,
        0.02,
      );
    }
  }

  public setChainBypassed(bypassed: boolean): void {
    this.chainBypassed = bypassed;
    this.rebuildLiveGraph();
  }

  public setChain(chain: ProcessorModule[]): void {
    this.currentChain = chain;
    this.rebuildLiveGraph();
  }

  public setAuditionTarget(target: AuditionTarget, loudnessTrimDb = 0): void {
    const prevTarget = this.auditionTarget;
    this.auditionTarget = target;
    this.setLoudnessTrimDb(loudnessTrimDb);

    const needsBufferSwitch =
      (prevTarget === 'reference') !== (target === 'reference') ||
      prevTarget.startsWith('candidate-') ||
      target.startsWith('candidate-') ||
      prevTarget === 'iteration' ||
      target === 'iteration';

    this.rebuildLiveGraph();
    if (this.isPlaying && needsBufferSwitch) {
      const pos = this.getCurrentTimeSec();
      this.play(pos);
    }
  }

  public setLoop(enabled: boolean, startSec: number, endSec: number): void {
    this.loopEnabled = enabled;
    this.loopStartSec = Math.max(0, startSec);
    this.loopEndSec = Math.max(this.loopStartSec + 0.1, endSec);
    if (this.activeSourceNode) {
      this.activeSourceNode.loop = enabled;
      this.activeSourceNode.loopStart = this.loopStartSec;
      this.activeSourceNode.loopEnd = Math.min(
        this.loopEndSec,
        this.activeSourceNode.buffer?.duration ?? this.loopEndSec,
      );
    }
  }

  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2.0, rate));
    if (this.activeSourceNode) {
      this.activeSourceNode.playbackRate.value = this.playbackRate;
    }
  }

  private getActiveBuffer(): AudioBuffer | null {
    if (this.auditionTarget === 'reference') {
      return this.referenceBuffer ?? this.sourceBuffer;
    }
    if (this.auditionTarget.startsWith('candidate-') || this.auditionTarget === 'iteration') {
      return this.overrideBuffers.get(this.auditionTarget) ?? this.sourceBuffer;
    }
    if (this.auditionTarget === 'mastered' && !this.chainBypassed && this.overrideBuffers.has('mastered-external')) {
      return this.overrideBuffers.get('mastered-external') ?? this.sourceBuffer;
    }
    return this.sourceBuffer;
  }

  private isLiveDspActive(): boolean {
    if (this.chainBypassed) return false;
    if (this.auditionTarget === 'original' || this.auditionTarget === 'reference') return false;
    if (this.auditionTarget.startsWith('candidate-') || this.auditionTarget === 'iteration') {
      // Override buffers are already offline-processed through exact DSP
      return false;
    }
    if (this.auditionTarget === 'mastered' && this.overrideBuffers.has('mastered-external')) {
      return false;
    }
    return true;
  }

  private makeSaturationCurve(flavor: SaturationParams['flavor'], driveAmt: number): Float32Array<ArrayBuffer> {
    const samples = 1024;
    const curve = new Float32Array(new ArrayBuffer(samples * 4));
    const drive = 1 + driveAmt * 3.2;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      if (flavor === 'hard-clip') {
        curve[i] = Math.max(-0.82, Math.min(0.82, x * drive));
      } else if (flavor === 'tape') {
        curve[i] = ((x * drive) / (1 + Math.abs(x * drive) * 0.72)) * 0.92;
      } else if (flavor === 'tube') {
        curve[i] = Math.tanh(x * drive + 0.08 * driveAmt) - Math.tanh(0.08 * driveAmt);
      } else {
        curve[i] = Math.tanh(x * drive);
      }
    }
    return curve;
  }

  private rebuildLiveGraph(): void {
    if (!this.ctx || !this.chainInputGain || !this.chainOutputGain) return;

    try {
      this.chainInputGain.disconnect();
    } catch {
      // ignore
    }
    for (const node of this.activeChainNodes) {
      try {
        node.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeChainNodes = [];
    this.compressorMonitors = [];

    if (!this.isLiveDspActive()) {
      this.chainInputGain.connect(this.chainOutputGain);
      return;
    }

    let cursor: AudioNode = this.chainInputGain;
    const connectStage = (inNode: AudioNode, outNode: AudioNode) => {
      cursor.connect(inNode);
      cursor = outNode;
    };

    for (const mod of this.currentChain) {
      if (!mod.enabled || mod.bypassed || mod.wetDry <= 0.1) continue;
      if (mod.type === 'external-vst3') continue;

      const stageIn = this.ctx.createGain();
      const stageOut = this.ctx.createGain();
      const dryGain = this.ctx.createGain();
      const wetGain = this.ctx.createGain();

      const wet = Math.max(0, Math.min(1, mod.wetDry / 100));
      const intensity = Math.max(0, Math.min(1, mod.intensity / 100));
      dryGain.gain.value = 1 - wet;
      wetGain.gain.value = wet;
      stageIn.gain.value = dbToLinear(mod.inputGainDb);
      stageOut.gain.value = dbToLinear(mod.outputGainDb);

      // Parallel dry path
      stageIn.connect(dryGain);
      dryGain.connect(stageOut);

      let procHead: AudioNode = stageIn;
      let procTail: AudioNode = stageIn;
      const trackNodes = (nodes: AudioNode[]) => {
        this.activeChainNodes.push(...nodes);
      };

      if (mod.type === 'parametric-eq') {
        const p = mod.params as ParametricEQParams;
        const eqNodes: BiquadFilterNode[] = [];
        for (const band of p.bands) {
          if (!band.enabled) continue;
          const bq = this.ctx.createBiquadFilter();
          bq.frequency.value = band.freq;
          bq.Q.value = band.q;
          bq.gain.value = band.gain * intensity;
          bq.type =
            band.shape === 'highpass'
              ? 'highpass'
              : band.shape === 'lowpass'
                ? 'lowpass'
                : band.shape === 'lowshelf'
                  ? 'lowshelf'
                  : band.shape === 'highshelf'
                    ? 'highshelf'
                    : band.shape === 'notch'
                      ? 'notch'
                      : 'peaking';
          eqNodes.push(bq);
        }
        if (Math.abs(p.tiltDb) > 0.05) {
          const tLo = this.ctx.createBiquadFilter();
          tLo.type = 'lowshelf';
          tLo.frequency.value = 650;
          tLo.gain.value = -p.tiltDb * 0.5 * intensity;
          const tHi = this.ctx.createBiquadFilter();
          tHi.type = 'highshelf';
          tHi.frequency.value = 1500;
          tHi.gain.value = p.tiltDb * 0.5 * intensity;
          eqNodes.push(tLo, tHi);
        }
        if (eqNodes.length > 0) {
          procHead = eqNodes[0];
          for (let i = 0; i < eqNodes.length - 1; i++) {
            eqNodes[i].connect(eqNodes[i + 1]);
          }
          procTail = eqNodes[eqNodes.length - 1];
          trackNodes(eqNodes);

          if (p.msMode === 'mid-side') {
            const split = this.ctx.createChannelSplitter(2);
            const merge = this.ctx.createChannelMerger(2);
            const gL = this.ctx.createGain();
            const gR = this.ctx.createGain();
            const gInvR = this.ctx.createGain();
            const midBus = this.ctx.createGain();
            const sideBus = this.ctx.createGain();
            const gStoR = this.ctx.createGain();
            gL.gain.value = 0.5;
            gR.gain.value = 0.5;
            gInvR.gain.value = -0.5;
            midBus.gain.value = 1.0;
            sideBus.gain.value = 1.0;
            gStoR.gain.value = -1.0;

            stageIn.connect(split);
            split.connect(gL, 0);
            split.connect(gR, 1);
            split.connect(gInvR, 1);

            gL.connect(midBus);
            gR.connect(midBus);
            gL.connect(sideBus);
            gInvR.connect(sideBus);

            midBus.connect(procHead);
            procTail.connect(merge, 0, 0);
            procTail.connect(merge, 0, 1);
            sideBus.connect(merge, 0, 0);
            sideBus.connect(gStoR);
            gStoR.connect(merge, 0, 1);
            merge.connect(wetGain);
            trackNodes([split, merge, gL, gR, gInvR, midBus, sideBus, gStoR]);
          } else {
            stageIn.connect(procHead);
            procTail.connect(wetGain);
          }
        } else {
          stageIn.connect(wetGain);
        }
      } else if (mod.type === 'compressor' || mod.type === 'multiband-comp') {
        const comp = this.ctx.createDynamicsCompressor();
        if (mod.type === 'compressor') {
          const p = mod.params as CompressorParams;
          comp.threshold.value = p.thresholdDb;
          comp.ratio.value = Math.max(1, 1 + (p.ratio - 1) * intensity);
          comp.attack.value = Math.max(0.001, p.attackMs / 1000);
          comp.release.value = Math.max(0.01, p.releaseMs / 1000);
          comp.knee.value = p.kneeDb;
          const makeup = this.ctx.createGain();
          makeup.gain.value = dbToLinear(p.makeupDb * intensity);
          stageIn.connect(comp);
          comp.connect(makeup);
          makeup.connect(wetGain);
          trackNodes([comp, makeup]);
        } else {
          const p = mod.params as MultibandCompParams;
          comp.threshold.value = p.mid.thresholdDb;
          comp.ratio.value = Math.max(1, 1 + (p.mid.ratio - 1) * intensity);
          comp.attack.value = p.mid.attackMs / 1000;
          comp.release.value = p.mid.releaseMs / 1000;
          stageIn.connect(comp);
          comp.connect(wetGain);
          trackNodes([comp]);
        }
        this.compressorMonitors.push(comp);
      } else if (mod.type === 'saturation') {
        const p = mod.params as SaturationParams;
        const shaper = this.ctx.createWaveShaper();
        shaper.oversample = p.oversampling >= 4 ? '4x' : p.oversampling >= 2 ? '2x' : 'none';
        shaper.curve = this.makeSaturationCurve(p.flavor, (p.drive / 100) * intensity);
        const tone = this.ctx.createBiquadFilter();
        tone.type = 'highshelf';
        tone.frequency.value = 3200;
        tone.gain.value = (p.tone / 100) * 4.5 * intensity;
        stageIn.connect(shaper);
        shaper.connect(tone);
        tone.connect(wetGain);
        trackNodes([shaper, tone]);
      } else if (mod.type === 'stereo-imager') {
        const p = mod.params as StereoImagerParams;
        // True Mid/Side Matrix via ChannelSplitter + GainNodes + ChannelMerger + L/R Balance
        const split = this.ctx.createChannelSplitter(2);
        const merge = this.ctx.createChannelMerger(2);
        const midGain = this.ctx.createGain();
        const sideGain = this.ctx.createGain();
        const avgWidth = (p.midWidth * 0.6 + p.highWidth * 0.4) / 100;
        const effWidth = 1 + (avgWidth - 1) * intensity;
        const bal = p.lrBalanceDb * intensity;

        const gL = this.ctx.createGain();
        const gR = this.ctx.createGain();
        const gInvR = this.ctx.createGain();
        const gMtoL = this.ctx.createGain();
        const gMtoR = this.ctx.createGain();
        const gStoL = this.ctx.createGain();
        const gStoR = this.ctx.createGain();
        const outSumL = this.ctx.createGain();
        const outSumR = this.ctx.createGain();

        gL.gain.value = 0.5;
        gR.gain.value = 0.5;
        gInvR.gain.value = -0.5;
        midGain.gain.value = 1.0;
        sideGain.gain.value = effWidth * dbToLinear(p.midSideGainDb * intensity);
        gMtoL.gain.value = 1.0;
        gMtoR.gain.value = 1.0;
        gStoL.gain.value = 1.0;
        gStoR.gain.value = -1.0;
        outSumL.gain.value = bal < 0 ? 1.0 : dbToLinear(-bal);
        outSumR.gain.value = bal > 0 ? 1.0 : dbToLinear(bal);

        stageIn.connect(split);
        split.connect(gL, 0);
        split.connect(gR, 1);
        split.connect(gInvR, 1);

        // Mid = 0.5*(L+R)
        gL.connect(midGain);
        gR.connect(midGain);
        // Side = 0.5*(L-R)
        gL.connect(sideGain);
        gInvR.connect(sideGain);

        midGain.connect(gMtoL);
        midGain.connect(gMtoR);
        sideGain.connect(gStoL);
        sideGain.connect(gStoR);

        gMtoL.connect(outSumL);
        gStoL.connect(outSumL);
        gMtoR.connect(outSumR);
        gStoR.connect(outSumR);
        outSumL.connect(merge, 0, 0);
        outSumR.connect(merge, 0, 1);
        merge.connect(wetGain);

        trackNodes([split, merge, midGain, sideGain, gL, gR, gInvR, gMtoL, gMtoR, gStoL, gStoR, outSumL, outSumR]);
      } else if (mod.type === 'bass-enhancer') {
        const p = mod.params as BassEnhancerParams;
        const bq = this.ctx.createBiquadFilter();
        bq.type = 'peaking';
        bq.frequency.value = p.subFreqHz;
        bq.Q.value = 0.9;
        bq.gain.value = p.subGainDb * intensity;
        stageIn.connect(bq);
        bq.connect(wetGain);
        trackNodes([bq]);
      } else if (mod.type === 'restore') {
        const p = mod.params as RestoreParams;
        const restoreNodes: AudioNode[] = [];
        const dcHpf = this.ctx.createBiquadFilter();
        dcHpf.type = 'highpass';
        dcHpf.frequency.value = p.dcOffset ? 22 : 5;
        restoreNodes.push(dcHpf);
        if (p.humRemovalHz > 0) {
          const humQ = p.mode === 'aggressive' ? 5 : 9;
          const hum1 = this.ctx.createBiquadFilter();
          hum1.type = 'notch';
          hum1.frequency.value = p.humRemovalHz;
          hum1.Q.value = humQ;
          const hum2 = this.ctx.createBiquadFilter();
          hum2.type = 'notch';
          hum2.frequency.value = p.humRemovalHz * 2;
          hum2.Q.value = humQ + 2;
          restoreNodes.push(hum1, hum2);
        }
        const deEss = this.ctx.createBiquadFilter();
        deEss.type = 'peaking';
        deEss.frequency.value = p.deEssFreqHz;
        deEss.Q.value = 2.2;
        deEss.gain.value = -(p.deEssAmount / 100) * 3.5 * intensity;
        restoreNodes.push(deEss);
        stageIn.connect(restoreNodes[0]);
        for (let i = 0; i < restoreNodes.length - 1; i++) {
          restoreNodes[i].connect(restoreNodes[i + 1]);
        }
        restoreNodes[restoreNodes.length - 1].connect(wetGain);
        trackNodes(restoreNodes);
      } else if (mod.type === 'dynamic-eq') {
        const p = mod.params as DynamicEQParams;
        const enabledBands = p.bands.filter((b) => b.enabled && b.maxCutDb < -0.05);
        const audioCtx = this.ctx;
        if (enabledBands.length > 0 && audioCtx) {
          const dynNodes = enabledBands.map((b) => {
            const bq = audioCtx.createBiquadFilter();
            bq.type = 'peaking';
            bq.frequency.value = b.freq;
            bq.Q.value = b.q;
            bq.gain.value = b.maxCutDb * 0.45 * intensity;
            return bq;
          });
          stageIn.connect(dynNodes[0]);
          for (let i = 0; i < dynNodes.length - 1; i++) {
            dynNodes[i].connect(dynNodes[i + 1]);
          }
          dynNodes[dynNodes.length - 1].connect(wetGain);
          trackNodes(dynNodes);
        } else {
          stageIn.connect(wetGain);
        }
      } else if (mod.type === 'limiter' || mod.type === 'maximizer') {
        const driveGain = this.ctx.createGain();
        const lim = this.ctx.createDynamicsCompressor();
        const ceilGain = this.ctx.createGain();
        if (mod.type === 'limiter') {
          const p = mod.params as LimiterParams;
          driveGain.gain.value = dbToLinear(-p.thresholdDb * intensity);
          lim.threshold.value = p.ceilingDb;
          lim.ratio.value = 20;
          lim.knee.value = 0;
          lim.attack.value = 0.001;
          lim.release.value = Math.max(0.015, p.releaseMs / 1000);
          ceilGain.gain.value = dbToLinear(p.ceilingDb) / dbToLinear(Math.min(0, p.ceilingDb));
        } else {
          const p = mod.params as MaximizerParams;
          const boostDb = Math.max(0, Math.min(12, (p.targetLufs + 18) * 0.65 * intensity));
          driveGain.gain.value = dbToLinear(boostDb);
          lim.threshold.value = p.ceilingDb;
          lim.ratio.value = 20;
          lim.knee.value = 0.5;
          lim.attack.value = 0.001;
          lim.release.value = p.character === 'aggressive' ? 0.045 : 0.095;
        }
        stageIn.connect(driveGain);
        driveGain.connect(lim);
        lim.connect(ceilGain);
        ceilGain.connect(wetGain);
        this.compressorMonitors.push(lim);
        trackNodes([driveGain, lim, ceilGain]);
      } else {
        // Offline-only processors (transient shaper, clipper, multiband maximizer):
        // the live approximation passes through; "Mastered" playback uses the exact
        // verified offline render.
        stageIn.connect(wetGain);
      }

      wetGain.connect(stageOut);
      trackNodes([stageIn, stageOut, dryGain, wetGain]);
      connectStage(stageIn, stageOut);
    }

    cursor.connect(this.chainOutputGain);
  }

  public play(startAtSec?: number): void {
    const buf = this.getActiveBuffer();
    if (!buf) return;
    const ctx = this.ensureContext();
    this.stopSourceOnly();

    this.rebuildLiveGraph();
    const offset = Math.max(0, Math.min(buf.duration - 0.02, startAtSec ?? this.pauseOffsetSec));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this.playbackRate;
    src.loop = this.loopEnabled;
    if (this.loopEnabled) {
      src.loopStart = this.loopStartSec;
      src.loopEnd = Math.min(buf.duration, this.loopEndSec);
    }

    src.connect(this.chainInputGain!);
    src.onended = () => {
      if (this.activeSourceNode === src && this.isPlaying) {
        this.isPlaying = false;
        this.pauseOffsetSec = 0;
        this.activeSourceNode = null;
        this.onEndedCallback?.();
      }
    };

    src.start(0, offset);
    this.activeSourceNode = src;
    this.startedAtCtxTime = ctx.currentTime - offset / this.playbackRate;
    this.isPlaying = true;
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.pauseOffsetSec = this.getCurrentTimeSec();
    this.stopSourceOnly();
    this.isPlaying = false;
  }

  public stop(): void {
    this.stopSourceOnly();
    this.isPlaying = false;
    this.pauseOffsetSec = 0;
  }

  public seek(sec: number): void {
    const dur = this.getDurationSec();
    const clamped = Math.max(0, Math.min(dur, sec));
    this.pauseOffsetSec = clamped;
    if (this.isPlaying) {
      this.play(clamped);
    }
  }

  private stopSourceOnly(): void {
    if (this.activeSourceNode) {
      try {
        this.activeSourceNode.onended = null;
        this.activeSourceNode.stop();
        this.activeSourceNode.disconnect();
      } catch {
        // ignore
      }
      this.activeSourceNode = null;
    }
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getDurationSec(): number {
    return this.getActiveBuffer()?.duration ?? 0;
  }

  public getCurrentTimeSec(): number {
    if (!this.isPlaying || !this.ctx) return this.pauseOffsetSec;
    const raw = (this.ctx.currentTime - this.startedAtCtxTime) * this.playbackRate;
    const dur = this.getDurationSec();
    if (this.loopEnabled && this.loopEndSec > this.loopStartSec) {
      const span = this.loopEndSec - this.loopStartSec;
      if (raw > this.loopStartSec) {
        return this.loopStartSec + ((raw - this.loopStartSec) % span);
      }
    }
    return dur > 0 ? Math.min(dur, Math.max(0, raw)) : 0;
  }

  public getLiveTelemetry(): LiveMeterSnapshot | null {
    if (!this.analyserL || !this.analyserR || !this.analyserMain) return null;
    this.analyserL.getFloatTimeDomainData(this.tdBufL);
    this.analyserR.getFloatTimeDomainData(this.tdBufR);
    this.analyserMain.getByteFrequencyData(this.fftBuf);

    let peakL = 0;
    let peakR = 0;
    let sumSqL = 0;
    let sumSqR = 0;
    let sumProd = 0;
    const n = this.tdBufL.length;

    for (let i = 0; i < n; i++) {
      const l = this.tdBufL[i];
      const r = this.tdBufR[i];
      if (Math.abs(l) > peakL) peakL = Math.abs(l);
      if (Math.abs(r) > peakR) peakR = Math.abs(r);
      sumSqL += l * l;
      sumSqR += r * r;
      sumProd += l * r;
    }

    const denom = Math.sqrt(sumSqL * sumSqR);
    const correlation = denom > 1e-10 ? Math.max(-1, Math.min(1, sumProd / denom)) : 1;

    let totalGr = 0;
    for (const c of this.compressorMonitors) {
      totalGr += Math.abs(c.reduction);
    }

    return {
      peakL: linearToDb(peakL),
      peakR: linearToDb(peakR),
      rmsL: linearToDb(Math.sqrt(sumSqL / n)),
      rmsR: linearToDb(Math.sqrt(sumSqR / n)),
      correlation,
      gainReductionDb: Number(totalGr.toFixed(2)),
      fftBins: this.fftBuf,
      timeDomainL: this.tdBufL,
      timeDomainR: this.tdBufR,
    };
  }
}
