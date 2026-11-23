# SYN MASTER
## ULTIMATE APPLICATION DEVELOPMENT SPECIFICATION
### Professional AI Audio Mastering, DSP Processing & Audio Intelligence Workstation

PROJECT NAME: SYN MASTER

PRODUCT CATEGORY: Professional Audio Engineering / AI Mastering / Digital Signal Processing

PRIMARY OBJECTIVE:

Develop a fully functional, professional-grade, browser-based audio mastering workstation capable of competing with and potentially surpassing established mastering platforms, including iZotope Ozone.

SYN MASTER must combine:

- Professional digital audio processing.
- Advanced DSP algorithms.
- AI-assisted mastering.
- Intelligent audio analysis.
- Automated mastering chain generation.
- Iterative mastering optimization.
- Reference track matching.
- Advanced audio restoration.
- Professional loudness management.
- High-quality offline rendering.
- Complete manual processing control.

This must be a genuine audio engineering application, not an audio-themed dashboard or visual prototype.

Every processor, parameter, visualization, button, slider, toggle, and processing function must have meaningful functionality.

Do not substitute visual representations for actual audio processing.

Do not claim that a feature is implemented unless it genuinely works.

Build a modular, extensible application that can grow into a complete professional mastering ecosystem.

==================================================
01. APPLICATION ARCHITECTURE
==================================================

Build SYN MASTER using a modular architecture.

Organize the application into the following independent systems:

SYN-ENGINE
Core audio engine responsible for playback, audio routing, real-time processing, buffering, and synchronization.

SYN-DSP
Collection of actual audio-processing algorithms and DSP modules.

SYN-ANALYZE
Audio analysis, frequency analysis, loudness measurement, spectral analysis, dynamics analysis, and stereo diagnostics.

SYN-MASTER AI
AI-powered mastering intelligence responsible for audio interpretation, processing decisions, parameter recommendations, and iterative optimization.

SYN-CHAIN
Dynamic signal routing, processor management, parallel processing, and mastering chain configuration.

SYN-REFERENCE
Reference track importing, analysis, comparison, and matching recommendations.

SYN-QC
Independent mastering quality control and technical validation.

SYN-RENDER
High-quality offline audio rendering and export.

SYN-PRESETS
Mastering presets, processor presets, user configurations, and custom chain management.

SYN-RESTORE
Audio cleanup, noise reduction, restoration, and spectral repair.

SYN-LAB
Advanced audio analysis and visualization workspace.

Each subsystem should have clearly defined interfaces and responsibilities.

Avoid tightly coupling the UI to the DSP implementation.

==================================================
02. TECHNOLOGY STACK
==================================================

FRONTEND:

- React.
- TypeScript.
- Chakra UI.
- Custom CSS.
- CSS Modules where appropriate.
- Responsive component architecture.

UI FRAMEWORK:

Use Chakra UI as the primary component framework.

Use Chakra UI for:
- Navigation.
- Sidebars.
- Buttons.
- Dropdowns.
- Menus.
- Dialogs.
- Modals.
- Tabs.
- Tooltips.
- Forms.
- Settings.
- Notifications.
- Layout components.
- Theme management.

Do not force Chakra UI to handle specialized audio controls.

Create custom React components for:
- Mastering rack modules.
- Equalizers.
- Waveforms.
- Frequency analyzers.
- Spectrograms.
- Audio meters.
- Vectorscopes.
- Gain reduction displays.
- Audio timelines.
- Stereo imaging displays.
- Precision parameter controls.

VISUALIZATION:

- HTML Canvas.
- WebGL where beneficial.
- Web Audio API analysis nodes.
- Custom rendering components.

AUDIO PROCESSING:

- Web Audio API.
- AudioWorklet.
- Web Workers.
- WebAssembly.
- Custom DSP implementations.
- Appropriate audio decoding libraries.

AI:

- Google Gemini API.
- Structured AI responses.
- Validated processor configurations.
- AI-assisted analysis interpretation.
- Intelligent mastering recommendations.

STORAGE:

- IndexedDB.
- Local project persistence.
- Local audio metadata.
- Preset storage.
- User settings.
- Project recovery.

BACKEND:

Implement backend services where necessary for:
- Gemini API requests.
- Secure credential management.
- Large-file processing.
- Cloud rendering.
- User authentication.
- Optional cloud project storage.

Keep API credentials server-side.

Never expose private API keys in browser code.

==================================================
03. BRANDING AND VISUAL DESIGN
==================================================

Create a distinctive premium professional audio workstation.

BRAND:
SYN MASTER

DESIGN PHILOSOPHY:

Professional mastering hardware meets modern digital audio engineering.

COLOR PALETTE:

- Near-black: #090B10
- Graphite: #11151C
- Elevated graphite: #191F29
- Metallic blue: #3289D6
- Electric blue accent: #48B5FF
- Silver: #C5CDD8
- Muted text: #8793A3
- White: #F4F7FA
- Success: #37C98B
- Warning: #E6AD4C
- Error: #E65D68

VISUAL CHARACTERISTICS:

- Dark graphite surfaces.
- Metallic blue accents.
- Subtle glass-like surfaces.
- Fine borders.
- Restrained gradients.
- Professional typography.
- Precise spacing.
- Clean information hierarchy.
- High-contrast audio measurements.
- Professional technical visualizations.

Avoid:
- Generic SaaS dashboard aesthetics.
- Excessive rounded cards.
- Unnecessary animations.
- Oversized decorative elements.
- Excessive empty space.
- Distracting visual effects.

Create a centralized design system with reusable tokens and components.

Include:
- Dark theme.
- Optional light theme.
- Adjustable accent color.
- Compact and comfortable density settings.
- Configurable panel layouts.

==================================================
04. MAIN APPLICATION WORKSPACE
==================================================

Create a professional DAW-inspired mastering workspace.

TOP TOOLBAR:

- SYN MASTER logo.
- Project name.
- Save.
- Save As.
- Undo.
- Redo.
- AI Mastering Assistant.
- Processing mode.
- Settings.
- Export.

LEFT SIDEBAR:

- Import Audio.
- Project Browser.
- Recent Projects.
- Audio Files.
- Reference Tracks.
- Mastering Presets.
- Processor Presets.
- Saved Chains.
- Mastering History.

CENTER WORKSPACE:

- Audio waveform.
- Timeline.
- Playback controls.
- Spectrum analyzer.
- Spectrogram.
- Track information.
- Original/processed comparison.
- Mastering analysis displays.

RIGHT SIDEBAR:

- Mastering Chain Rack.
- Add Processor.
- Processor Controls.
- Processor Ordering.
- Effect Intensity.
- Bypass.
- Input/Output Levels.
- Advanced Settings.

BOTTOM PANEL:

- Master output.
- Peak meters.
- RMS meters.
- LUFS measurements.
- True Peak.
- Stereo Correlation.
- Gain Reduction.
- Processing Status.
- Export Status.

Allow panels to:
- Expand.
- Collapse.
- Resize.
- Reposition where appropriate.
- Persist layout preferences.

Include full-screen mastering workspace mode.

==================================================
05. AUDIO IMPORT AND FILE MANAGEMENT
==================================================

Support:

- WAV.
- MP3.
- FLAC.
- AAC.
- M4A.
- OGG.
- AIFF.

Implement:
- Drag-and-drop import.
- File browser.
- Multiple file import.
- Audio format detection.
- Metadata extraction.
- File validation.
- Audio decoding.
- Waveform generation.
- Project association.

Display:

- Filename.
- Duration.
- File size.
- Sample rate.
- Bit depth.
- Channel count.
- Mono/stereo/multichannel status.
- Peak level.
- RMS.
- Integrated loudness when analyzed.

Preserve original uploaded files.

Never destructively overwrite source audio.

For unsupported formats, provide an understandable error and conversion guidance.

Support large audio files through appropriate buffering and memory management.

==================================================
06. AUDIO PLAYBACK AND MONITORING
==================================================

Implement a functional audio playback system.

Controls:

- Play.
- Pause.
- Stop.
- Seek.
- Loop.
- Previous.
- Next.
- Playback volume.
- Timeline scrubbing.
- Playback speed where appropriate.
- Playhead position.
- Track duration.

Support:

- Real-time processed playback.
- Original playback.
- A/B comparison.
- Seamless processor bypass.
- Playback synchronization.
- Loop regions.
- Selection-based playback.

Include independent monitoring volume that does not modify the exported master.

Prevent unintended audio feedback loops.

Ensure smooth playback when modifying DSP parameters.

==================================================
07. MASTERING CHAIN RACK
==================================================

This is the central processing interface.

Build a professional modular insert rack similar to mastering chains in advanced DAWs.

Each processor must have an independent module.

MODULE CONTROLS:

- Processor name.
- ON/OFF toggle.
- Bypass.
- Effect intensity.
- Wet/dry mix.
- Input gain.
- Output gain.
- Gain reduction where applicable.
- Expand/collapse.
- Advanced parameters.
- Preset selection.
- Reset.
- Remove.
- Duplicate.

EFFECT INTENSITY:

Provide an adjustable 0-100% control.

Implement appropriate processing-strength behavior for each processor.

For processors with naturally continuous processing, use appropriate intensity scaling.

For processors without an intensity parameter, use an appropriate wet/dry blend.

Do not use arbitrary output attenuation as a substitute for controlling effect intensity.

CHAIN MANAGEMENT:

- Add processors.
- Remove processors.
- Duplicate processors.
- Rearrange processors through drag and drop.
- Save chains.
- Load chains.
- Reset chains.
- Copy settings.
- Paste settings.
- Compare processor contributions.
- Bypass entire chain.
- Enable/disable individual modules.

Support serial and parallel processing.

Include visual signal-flow indicators.

Show input and output levels for every processor.

Allow users to create groups and organize processor chains.

==================================================
08. COMPLETE DSP PROCESSOR LIBRARY
==================================================

Implement a comprehensive collection of actual audio processors.

A. EQUALIZATION

- Parametric EQ.
- Graphic EQ.
- Dynamic EQ.
- Linear-phase EQ.
- Minimum-phase EQ.
- High-pass filter.
- Low-pass filter.
- Low shelf.
- High shelf.
- Bell filter.
- Notch filter.
- Tilt EQ.
- Mid/Side EQ.
- Dynamic resonance suppression.

PARAMETERS:

- Frequency.
- Gain.
- Q factor.
- Bandwidth.
- Filter slope.
- Dynamic threshold.
- Attack.
- Release.
- Processing intensity.

Include:
- Interactive frequency response.
- Draggable EQ nodes.
- Frequency markers.
- Adjustable bands.
- Individual band bypass.
- Spectrum overlay.
- Pre/post comparison.

B. DYNAMICS

- Single-band compressor.
- Multiband compressor.
- Spectral compressor.
- Dynamic compressor.
- Upward compression.
- Downward compression.
- Parallel compression.
- Transient shaper.
- Transient recovery.
- Peak limiter.
- True Peak limiter.
- Soft clipper.
- Hard clipper.
- Intelligent maximizer.

PARAMETERS:

- Threshold.
- Ratio.
- Attack.
- Release.
- Knee.
- Makeup gain.
- Input gain.
- Output gain.
- Lookahead.
- Oversampling.

Display gain reduction and compression behavior.

C. HARMONIC PROCESSING

- Harmonic exciter.
- Multiband exciter.
- Tube saturation.
- Tape saturation.
- Analog-style coloration.
- Soft saturation.
- Hard saturation.
- Harmonic enhancement.
- Bass harmonic generation.
- High-frequency enhancement.

Include harmonic intensity and tonal character controls.

D. STEREO PROCESSING

- Stereo imager.
- Multiband stereo imager.
- Stereo widening.
- Stereo narrowing.
- Mid/Side processing.
- Mid/Side compression.
- Channel balancing.
- Phase alignment.
- Mono conversion.
- Stereo enhancement.

Include frequency-dependent stereo width controls.

E. RESTORATION

- Broadband noise reduction.
- Spectral denoising.
- Hiss removal.
- Hum removal.
- Click removal.
- Pop removal.
- De-essing.
- Resonance suppression.
- DC offset correction.
- Adaptive spectral attenuation.

Provide conservative and aggressive processing modes where appropriate.

F. LOW-FREQUENCY PROCESSING

- Sub-bass enhancement.
- Bass harmonics.
- Low-frequency compression.
- Bass transient control.
- Low-frequency stereo management.
- Sub-frequency filtering.
- Bass clarity enhancement.

G. FINALIZATION

- Loudness normalization.
- Peak normalization.
- True Peak limiting.
- Final limiting.
- Dithering.
- Sample-rate conversion.
- Bit-depth conversion.

All modules must have genuine processing implementations.

==================================================
09. ADVANCED SPECTRAL ENGINE
==================================================

Develop a dedicated high-resolution spectral processing system.

Capabilities:

- FFT analysis.
- STFT analysis.
- High-resolution spectrogram.
- Harmonic detection.
- Resonance detection.
- Spectral balance measurement.
- Frequency-dependent attenuation.
- Spectral enhancement.
- Dynamic spectral processing.
- Transient-sensitive spectral processing.
- Frequency masking analysis.

Support:
- Adjustable FFT resolution.
- Window selection.
- Overlap settings.
- Frequency range selection.
- Logarithmic frequency display.
- Linear frequency display.
- Adjustable visual gain.

Implement appropriate overlap-add reconstruction and windowing.

Maintain signal quality and avoid unnecessary processing artifacts.

==================================================
10. SYN-ANALYZE AUDIO ANALYSIS ENGINE
==================================================

Analyze uploaded audio before and after processing.

LOUDNESS:

- Integrated LUFS.
- Short-term LUFS.
- Momentary LUFS.
- RMS.
- Sample Peak.
- True Peak.
- Loudness Range.

DYNAMICS:

- Dynamic Range.
- Crest Factor.
- Peak-to-Loudness Ratio.
- Transient characteristics.
- Loudness variation.
- Compression behavior.

FREQUENCY:

- Frequency response.
- Spectral balance.
- Harmonic distribution.
- Resonance detection.
- Bass energy.
- Midrange balance.
- High-frequency harshness.
- Spectral density.

STEREO:

- Stereo width.
- Mid/Side balance.
- Phase correlation.
- Mono compatibility.
- Left/right balance.
- Frequency-dependent stereo distribution.

DISTORTION:

- Clipping.
- Inter-sample peaks.
- Harmonic distortion.
- Total Harmonic Distortion.
- Processing-induced distortion.

Generate a detailed audio diagnostic report.

Distinguish actual measured values from estimated or AI-interpreted characteristics.

==================================================
11. SYN-MASTER AI INTELLIGENCE
==================================================

Integrate Google Gemini as the intelligent mastering decision engine.

The AI must analyze actual audio measurements and use them to develop mastering strategies.

Do not rely on generic genre presets.

INITIAL ANALYSIS:

Identify:
- Genre.
- Musical style.
- Instrumentation.
- Vocal presence.
- Tonal characteristics.
- Bass buildup.
- Harsh frequencies.
- Resonances.
- Dynamic issues.
- Transient problems.
- Stereo problems.
- Clipping.
- Distortion.
- Loudness characteristics.

Allow users to correct AI classifications.

MASTERING PLAN:

Generate an intelligent processing strategy.

Determine:
- Necessary processors.
- Unnecessary processors.
- Processing order.
- Initial parameters.
- Processing intensity.
- Frequency corrections.
- Compression requirements.
- Stereo adjustments.
- Loudness objectives.

AUTOMATIC CHAIN GENERATION:

Construct a customized chain using actual available processors.

Avoid unnecessary processing.

PROCESSING:

Send validated configurations to SYN-DSP.

EVALUATION:

Analyze the processed output.

Identify improvements and problems.

REFINEMENT:

Modify parameters where justified.

Generate new processing iterations.

FINAL REPORT:

Show:
- Original analysis.
- Mastering strategy.
- Processors used.
- Parameter changes.
- Final measurements.
- Improvements.
- Remaining issues.
- Recommendations.

AI ARCHITECTURE REQUIREMENTS:

Gemini is responsible for interpretation and decision-making.

SYN-DSP is responsible for actual audio processing.

Never tell users that audio has been processed when only an AI recommendation has been generated.

Validate every AI-generated configuration before executing it.

==================================================
12. ITERATIVE SELF-MASTERING
==================================================

Implement an intelligent multi-pass mastering optimization system.

WORKFLOW:

PASS 1:
Analyze original audio.

PASS 2:
Generate initial mastering strategy.

PASS 3:
Construct processing chain.

PASS 4:
Render initial master.

PASS 5:
Measure output.

PASS 6:
Identify deficiencies and unintended degradation.

PASS 7:
Adjust processing.

PASS 8:
Render improved candidate.

PASS 9:
Compare candidates.

PASS 10:
Select the best candidate.

PASS 11:
Run final quality control.

PASS 12:
Deliver final master.

Allow users to configure:

- Maximum iterations.
- Processing aggressiveness.
- Loudness objective.
- Dynamic preservation.
- Tonal balance preference.
- Stereo enhancement preference.
- Distortion tolerance.
- Processing transparency.

Store every iteration.

Allow users to:
- Audition iterations.
- Compare measurements.
- Revert.
- Continue refining.
- Select a previous version.

Use multi-objective optimization.

Do not assume that louder means better.

Never automatically introduce aggressive processing just to improve a numerical score.

==================================================
13. SYN-REFERENCE
==================================================

Allow users to upload reference tracks.

Support multiple reference tracks.

Analyze:

- Frequency response.
- Spectral balance.
- Loudness.
- Dynamic range.
- Crest factor.
- Stereo width.
- Phase.
- Bass energy.
- High-frequency energy.
- Transient characteristics.

Provide:

- Reference waveform.
- Source waveform.
- Spectrum comparison.
- Loudness comparison.
- Stereo comparison.
- Tonal difference visualization.
- Recommendations.

Implement loudness-matched A/B playback.

Allow users to select which characteristics they want to reference.

Do not blindly copy the reference EQ curve.

Account for differences in instrumentation, arrangement, genre, and dynamics.

==================================================
14. MASTERING MODES
==================================================

Provide the following modes:

AI AUTOMATIC:
Fully automated intelligent mastering.

MANUAL:
Complete control over every processor.

HYBRID:
AI recommendations with manual control.

TRANSPARENT:
Prioritize natural sound and original dynamics.

LOUDNESS MAXIMIZATION:
Maximize perceived loudness while controlling distortion.

ANALOG CHARACTER:
Emphasize harmonic coloration and saturation.

DYNAMIC PRESERVATION:
Preserve transient integrity and dynamics.

REFERENCE MATCH:
Optimize toward a selected reference.

STREAMING DELIVERY:
Prepare audio for configurable streaming delivery specifications.

CUSTOM:
User-defined mastering objectives.

==================================================
15. SYN MASTER BATTLE MODE
==================================================

Create a multi-master generation and comparison system.

Generate three independently optimized masters.

MASTER A:
Transparent and dynamic.

MASTER B:
Commercially loud, punchy, and energetic.

MASTER C:
Warm, rich, harmonically enhanced.

Each candidate must use independently configured processing chains.

Provide:

- A/B/C auditioning.
- Randomized playback order.
- Optional blind mode.
- Loudness matching.
- Instant switching.
- Waveform comparisons.
- Spectrum comparisons.
- Technical measurements.
- Final candidate selection.

Allow the user to select a winning master and continue editing it.

Do not simply apply three presets to the same processing configuration.

==================================================
16. SYN-QC QUALITY CONTROL
==================================================

Implement an independent mastering validation system.

Check:

- Sample clipping.
- True Peak.
- Inter-sample peaks.
- Excessive limiting.
- Distortion.
- Dynamic range reduction.
- Transient degradation.
- Phase issues.
- Stereo compatibility.
- Frequency imbalance.
- Excessive bass.
- Excessive high frequencies.
- Noise.
- Loudness compliance.

Provide:
- Pass/warning/fail indicators.
- Detailed explanations.
- Suggested corrections.
- Pre-master/post-master comparisons.
- Final technical report.

Allow configurable quality-control targets.

==================================================
17. SYN MASTER LAB
==================================================

Create a dedicated advanced analysis environment.

FREQUENCY LAB:

- FFT.
- Spectrogram.
- Harmonic analysis.
- Resonance detection.
- Spectral comparison.
- Frequency response.

DYNAMICS LAB:

- Loudness history.
- Gain reduction.
- Crest factor.
- Transient analysis.
- Dynamic range.

STEREO LAB:

- Vectorscope.
- Phase correlation.
- Mid/Side analysis.
- Stereo width.
- Mono compatibility.

DISTORTION LAB:

- THD.
- Harmonic distortion.
- Clipping detection.
- Inter-sample peak analysis.
- Saturation analysis.

All visualizations must represent actual audio measurements.

==================================================
18. PROFESSIONAL MASTERING PRESETS
==================================================

Include starting presets for:

- Pop.
- Hip-Hop.
- Trap.
- R&B.
- Electronic.
- EDM.
- Rock.
- Indie.
- Acoustic.
- Classical.
- Cinematic.
- Vocal-focused music.

Include processing philosophy presets:

- Transparent.
- Warm.
- Punchy.
- Dynamic.
- Loud.
- Wide.
- Smooth.
- Bright.
- Dark.
- Balanced.

Allow users to:

- Save presets.
- Edit presets.
- Duplicate presets.
- Delete custom presets.
- Import presets.
- Export presets.
- Save complete mastering chains.
- Recall previous configurations.

Presets must be starting points, not fixed mastering decisions.

==================================================
19. EXPORT AND DELIVERY ENGINE
==================================================

Implement professional offline audio rendering.

FORMATS:

- WAV.
- FLAC.
- MP3.
- AAC.

WAV OPTIONS:

- 16-bit.
- 24-bit.
- 32-bit floating point.

CONFIGURATION:

- Sample rate.
- Bit depth.
- Bitrate.
- Channel format.
- Integrated LUFS target.
- True Peak ceiling.
- Dithering.
- Oversampling.
- Metadata.
- Filename.

Include delivery profiles for streaming and professional distribution.

Allow users to configure their own targets.

Include:
- Single export.
- Multiple version export.
- Batch export.
- Progress indicator.
- Export cancellation.
- Download management.
- Final quality report.

Preserve original audio.

Use the same DSP algorithms and configurations in offline rendering as in real-time playback.

Perform sample-rate conversion and dithering only when appropriate.

==================================================
20. PROJECT MANAGEMENT AND USER SETTINGS
==================================================

Implement:

- New Project.
- Open Project.
- Save Project.
- Save As.
- Duplicate Project.
- Rename Project.
- Delete Project.
- Recent Projects.
- Automatic Recovery.
- Project History.

Store:
- Source audio references.
- Mastering chain.
- Processor parameters.
- Reference tracks.
- AI analysis.
- Mastering iterations.
- Export configurations.
- Workspace layout.

Use IndexedDB for local project persistence.

Clearly communicate storage limitations.

==================================================
21. ADVANCED WORKFLOW FEATURES
==================================================

Include:

- Undo and redo.
- Processing history.
- A/B comparison.
- Before/after waveform.
- Loudness matching.
- Copy/paste processor settings.
- Processor groups.
- Custom chain ordering.
- Parallel processing.
- Chain presets.
- Keyboard shortcuts.
- Adjustable monitoring.
- Session recovery.
- Project duplication.
- Batch processing.

Provide a contextual help system explaining processors and their parameters.

Include an optional beginner-friendly interface mode and an advanced engineering mode.

==================================================
22. PERFORMANCE AND AUDIO ENGINEERING
==================================================

Implement:

- Proper gain staging.
- High-precision internal processing.
- Anti-aliasing.
- Oversampling.
- Latency compensation.
- Sample-rate handling.
- Channel configuration.
- Smooth parameter automation.
- Click-free processor switching.
- Efficient buffering.
- Memory management.
- Processing synchronization.

Separate real-time playback from offline rendering.

Use Web Workers and AudioWorklet where appropriate.

Use WebAssembly for computationally intensive DSP where beneficial.

Support long-form audio efficiently.

Avoid unnecessarily duplicating large audio buffers.

Provide processing quality settings where computational tradeoffs exist.

Prevent:
- Audio feedback.
- Runaway gain.
- Unexpected clipping.
- Broken signal connections.
- Unnecessary latency.
- UI freezing.
- Corrupted output.

==================================================
23. SECURITY AND RELIABILITY
==================================================

Implement:

- Secure API key handling.
- Server-side Gemini requests.
- File validation.
- File size limits.
- Audio format validation.
- Safe configuration parsing.
- AI response validation.
- Error handling.
- Resource cleanup.
- Session recovery.

Never expose private API credentials.

Never execute arbitrary AI-generated code.

Only permit AI to configure predefined, validated DSP operations.

==================================================
24. TESTING AND VERIFICATION
==================================================

Test each subsystem independently.

DSP TESTING:

- Frequency response.
- Compression behavior.
- Limiter behavior.
- Harmonic generation.
- Stereo processing.
- Wet/dry mixing.
- Bypass behavior.
- Gain staging.
- Signal routing.
- Numerical stability.

AUDIO TESTING:

- Sine waves.
- Swept sine signals.
- White noise.
- Pink noise.
- Impulse responses.
- Controlled stereo signals.
- Real-world music samples.

RENDER TESTING:

- Duration preservation.
- Channel integrity.
- Sample-rate correctness.
- Bit-depth correctness.
- Clipping detection.
- Export validity.
- Real-time/offline consistency.

AI TESTING:

- Configuration validation.
- Reasoning consistency.
- Appropriate processor selection.
- Safe parameter ranges.
- Iterative refinement.
- Failure handling.

UI TESTING:

- Every button.
- Every toggle.
- Every slider.
- Every processor module.
- Every navigation item.
- Every export option.

Never mark an implementation complete solely because the interface renders.

Clearly distinguish:
- Fully implemented.
- Partially implemented.
- Planned.
- Unsupported.

==================================================
25. DEVELOPMENT EXECUTION STRATEGY
==================================================

Build incrementally.

Do not attempt to implement the entire advanced DSP ecosystem as superficial placeholders.

PHASE 1: FOUNDATION

- Application shell.
- Chakra UI integration.
- Design system.
- Project management.
- Audio upload.
- Audio decoding.
- Waveform.
- Playback engine.

PHASE 2: DSP FOUNDATION

- Audio signal graph.
- Mastering rack.
- EQ.
- Compressor.
- Limiter.
- Saturation.
- Stereo processing.
- Processor bypass.
- Wet/dry controls.
- Chain ordering.

PHASE 3: ANALYSIS

- Spectrum analyzer.
- Spectrogram.
- LUFS.
- RMS.
- True Peak.
- Dynamic range.
- Stereo correlation.
- Waveform comparisons.

PHASE 4: AI INTELLIGENCE

- Gemini integration.
- Audio diagnostic interpretation.
- Mastering recommendations.
- Chain generation.
- Validated DSP configurations.

PHASE 5: ADVANCED MASTERING

- Spectral processing.
- Multiband dynamics.
- Reference matching.
- Iterative mastering.
- Mastering history.

PHASE 6: BATTLE MODE

- Three independent mastering candidates.
- Loudness matching.
- Blind comparison.
- Candidate selection.

PHASE 7: QUALITY CONTROL AND EXPORT

- SYN-QC.
- Offline rendering.
- Format conversion.
- Dithering.
- Batch export.
- Final reporting.

PHASE 8: OPTIMIZATION

- Performance profiling.
- Audio quality validation.
- Memory optimization.
- UI refinement.
- Cross-browser testing.
- Reliability testing.

After each phase:
1. Inspect the implementation.
2. Run relevant tests.
3. Verify actual behavior.
4. Identify incomplete functionality.
5. Correct problems.
6. Re-test before proceeding.

Do not silently replace broken functionality with placeholders.

==================================================
26. FINAL PRODUCT DEFINITION
==================================================

SYN MASTER must ultimately deliver the following:

A PROFESSIONAL AUDIO WORKSTATION:
A complete DAW-inspired mastering interface.

A REAL DSP ENGINE:
Actual audio processing with modular signal routing.

AN INTELLIGENT MASTERING ASSISTANT:
AI-assisted analysis and mastering decisions.

A DYNAMIC PROCESSING RACK:
Fully configurable mastering chains.

AN ADVANCED ANALYSIS ENGINE:
Professional audio measurements and diagnostics.

ITERATIVE SELF-MASTERING:
Multiple optimization passes with version comparison.

REFERENCE MATCHING:
Reference track analysis and intelligent recommendations.

MASTERING BATTLE MODE:
Three independently generated mastering candidates.

QUALITY CONTROL:
Independent technical validation of every master.

PROFESSIONAL RENDERING:
High-quality offline audio processing and export.

AN EXTENSIBLE ARCHITECTURE:
A modular platform that can continue growing.

==================================================
27. FINAL DEVELOPMENT DIRECTIVE
==================================================

Build SYN MASTER as a serious professional audio engineering platform.

The quality of the actual audio processing is more important than the number of features.

Do not build fake processors.

Do not fabricate measurements.

Do not simulate audio processing.

Do not claim AI has mastered a track when it has only generated recommendations.

Do not use generic presets as a substitute for intelligent analysis.

Do not sacrifice musical dynamics simply to increase loudness.

Do not sacrifice sound quality for visual effects.

Every processor must perform its intended operation.

Every measurement must be calculated from actual audio.

Every rendered master must pass through the real DSP engine.

The AI must be able to interact with the actual processing architecture through validated configurations.

The application must remain fully usable in manual mode even when AI services are unavailable.

Build the application in verified stages, maintaining a clear record of completed, incomplete, and planned capabilities.

ULTIMATE OBJECTIVE:

Create an intelligent, extensible mastering workstation that combines the precision of professional DSP, the flexibility of a modular DAW, the analytical capabilities of advanced audio engineering software, and the decision-making capabilities of modern AI.

SYN MASTER should give users complete control over their sound while providing an intelligent mastering system capable of analyzing, processing, evaluating, and refining audio.

ONE TRACK.

MULTIPLE MASTERING STRATEGIES.

INTELLIGENT OPTIMIZATION.

COMPLETE CREATIVE CONTROL.

EXCEPTIONAL SOUND.

END OF SPECIFICATION.