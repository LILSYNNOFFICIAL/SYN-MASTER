import type {
  AudioAnalysis,
  ExternalPluginRecord,
  PluginCapabilityMatch,
  PluginIntelligenceSummary,
  PluginParameterInfo,
  ResolvedObjectiveTarget,
} from '../types/mastering';

function inferPluginRole(plugin: ExternalPluginRecord): PluginCapabilityMatch['role'] {
  const hay = `${plugin.name} ${plugin.category} ${plugin.subCategories.join(' ')}`.toLowerCase();
  if (hay.includes('limit') || hay.includes('maxim')) return 'limiter';
  if (hay.includes('comp') || hay.includes('dynam')) return 'dynamics';
  if (hay.includes('eq') || hay.includes('tilt') || hay.includes('filter')) return 'eq';
  if (hay.includes('stereo') || hay.includes('width') || hay.includes('imager')) return 'stereo';
  if (hay.includes('sat') || hay.includes('tape') || hay.includes('tube') || hay.includes('warm')) return 'saturation';
  if (hay.includes('restor') || hay.includes('denoise') || hay.includes('deess')) return 'restore';
  return 'utility';
}

function findMatchingParam(
  params: PluginParameterInfo[],
  keywords: string[],
): PluginParameterInfo | undefined {
  return params.find((p) => {
    if (p.isReadOnly || p.isBypass) return false;
    const name = p.name.toLowerCase();
    return keywords.some((kw) => name.includes(kw));
  });
}

/**
 * SYN-PLUGIN Intelligence
 * Strictly inspects ONLY real connected host plugins (`status === 'available' && !disabledByUser`).
 * Never assumes any third-party VST3 exists or can execute when host is offline.
 */
export function inspectPluginInventory(
  plugins: ExternalPluginRecord[],
  hostConnected: boolean,
  analysis?: AudioAnalysis | null,
  objective?: ResolvedObjectiveTarget | null,
): PluginIntelligenceSummary {
  if (!hostConnected) {
    return {
      hostConnected: false,
      discoveredCount: plugins.length,
      compatibleAvailableCount: 0,
      statusSummary:
        'SYN-PLUGIN HOST is not connected (browser-only mode). External VST3 plugins cannot be loaded or processed; Mastering Director will operate strictly on native SYN-DSP processors.',
      matches: [],
    };
  }

  const usable = plugins.filter(
    (p) => p.status === 'available' && !p.disabledByUser && p.format === 'vst3',
  );

  if (usable.length === 0) {
    return {
      hostConnected: true,
      discoveredCount: plugins.length,
      compatibleAvailableCount: 0,
      statusSummary:
        plugins.length === 0
          ? 'Host connected, but 0 VST3 plugins have been discovered. Run a plugin scan in the Plugins tab or proceed with native SYN-DSP.'
          : `Host connected (${plugins.length} catalogued), but 0 compatible/enabled VST3 plugins are available.`,
      matches: [],
    };
  }

  const matches: PluginCapabilityMatch[] = usable.map((plugin) => {
    const role = inferPluginRole(plugin);
    const recommendedParams: PluginCapabilityMatch['recommendedParams'] = [];

    if (analysis && objective) {
      // Inspect genuine APVTS / VST3 parameter metadata to derive normalized parameter settings
      const gainParam = findMatchingParam(plugin.parameters, ['gain', 'output', 'trim', 'level']);
      if (gainParam) {
        const headroomGainDb = Math.max(
          -6,
          Math.min(6, (objective.targetLufs - analysis.integratedLufs) * 0.25),
        );
        // Normalized around 0.5 center (typical APVTS +/-12dB or linear trim centered at default)
        const norm = Math.max(0.15, Math.min(0.85, gainParam.defaultValueNormalized + headroomGainDb / 24));
        recommendedParams.push({
          paramId: gainParam.id,
          paramName: gainParam.name,
          normalizedValue: Number(norm.toFixed(3)),
          rationale: `Calibrates output gain trim (~${headroomGainDb >= 0 ? '+' : ''}${headroomGainDb.toFixed(1)} dB) toward ${objective.targetLufs} LUFS objective.`,
        });
      }

      const tiltParam = findMatchingParam(plugin.parameters, ['tilt', 'tone', 'bright', 'air']);
      if (tiltParam) {
        let tiltShift = 0;
        if (objective.tonalBias === 'bright' || analysis.spectralSlopeDbPerOct < -2.4) {
          tiltShift = 0.08;
        } else if (objective.tonalBias === 'warm') {
          tiltShift = -0.08;
        }
        const norm = Math.max(0.1, Math.min(0.9, tiltParam.defaultValueNormalized + tiltShift));
        recommendedParams.push({
          paramId: tiltParam.id,
          paramName: tiltParam.name,
          normalizedValue: Number(norm.toFixed(3)),
          rationale: `Adjusts spectral tilt (${objective.tonalBias} bias vs measured ${analysis.spectralSlopeDbPerOct.toFixed(2)} dB/oct slope).`,
        });
      }

      const ceilingParam = findMatchingParam(plugin.parameters, ['ceiling', 'ceil', 'limit']);
      if (ceilingParam && role === 'limiter') {
        const norm = Math.max(0.1, Math.min(0.95, 1 + objective.maxTruePeakDb / 6));
        recommendedParams.push({
          paramId: ceilingParam.id,
          paramName: ceilingParam.name,
          normalizedValue: Number(norm.toFixed(3)),
          rationale: `Targets ceiling ${objective.maxTruePeakDb.toFixed(1)} dBTP.`,
        });
      }
    }

    return {
      uid: plugin.uid,
      name: plugin.name,
      manufacturer: plugin.manufacturer,
      format: plugin.format,
      role,
      available: true,
      reason: `${plugin.manufacturer} ${plugin.name} (${plugin.parameterCount} parameters, ${plugin.latencySamples} samples latency) is available via connected host.`,
      recommendedParams,
    };
  });

  return {
    hostConnected: true,
    discoveredCount: plugins.length,
    compatibleAvailableCount: matches.length,
    statusSummary: `Host connected: ${matches.length} compatible VST3 plugin(s) ready (${matches.map((m) => m.name).join(', ')}).`,
    matches,
  };
}
