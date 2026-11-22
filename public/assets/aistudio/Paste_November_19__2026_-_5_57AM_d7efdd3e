# SYN MASTER | ENGINEERING PHASE: PERFORMANCE OPTIMIZATION + AUTONOMOUS AI MASTERING

## MASTER DIRECTIVE

CONTINUE ENGINEERING THE EXISTING SYN MASTER APPLICATION.

This is an existing, actively developed application. You are NOT starting a new project, creating a replacement application, or redesigning the architecture from scratch.

Your responsibility is to inspect the existing implementation, understand how its components work together, identify actual engineering problems, implement improvements, and independently verify the results.

This phase has TWO PRIMARY OBJECTIVES:

1. REAL-TIME PERFORMANCE OPTIMIZATION.
2. IMPLEMENTATION OF A FULLY FUNCTIONAL AUTONOMOUS MASTERING FEATURE CALLED "CHAIN WITH AI".

Both objectives must be integrated into the existing SYN MASTER architecture without sacrificing existing functionality, audio quality, stability, or interface consistency.

This is an engineering assignment, not a mockup exercise.

Do not substitute simulated functionality, placeholder controls, fabricated measurements, or visual demonstrations for actual working implementations.

---

# PART 1: PROJECT INSPECTION AND PROTECTION

Before making changes, perform a comprehensive inspection of the existing project.

Inspect:

- Current Git branch and working tree.
- Existing uncommitted changes.
- Recent commits and repository state.
- Application architecture.
- Frontend components and state management.
- Audio engine and DSP architecture.
- Existing mastering processors.
- AI integration and Gemini configuration.
- Server-side API implementation.
- Audio analysis and measurement systems.
- Playback and recording pipelines.
- Real-time telemetry.
- Metering and visualization systems.
- Existing presets and mastering profiles.
- Existing tests and CI workflows.
- Current application behavior.

Identify dependencies between components before modifying anything.

IMPORTANT:

- Never overwrite or discard existing work.
- Never reset the repository to an earlier state.
- Never delete functioning functionality simply because replacing it is easier.
- Never introduce duplicate implementations when existing systems can be extended.
- Preserve existing architecture unless a demonstrated technical limitation requires a change.
- Make changes incrementally and keep them reversible.

Work on the existing engineering branch.

Do not commit to main.

Do not merge the existing pull request.

Do not publish or modify the live deployment.

---

# PART 2: REAL-TIME PERFORMANCE OPTIMIZATION

## Objective

Improve the responsiveness, efficiency, and stability of SYN MASTER, particularly during continuous audio playback, recording, analysis, and mastering.

An existing performance concern is that audio telemetry updates approximately 30 times per second and may trigger unnecessary React application-wide re-renders.

Investigate this behavior rather than assuming the suspected cause is the only bottleneck.

## 2.1 Telemetry Architecture

Inspect the complete telemetry data flow.

Identify:

- Where audio telemetry originates.
- How frequently telemetry is generated.
- How telemetry is transmitted to React.
- Which components subscribe to telemetry.
- Which state updates trigger component rendering.
- Whether unrelated components re-render unnecessarily.
- Whether visualizer rendering is coupled to application-wide state.

Implement an efficient architecture that separates high-frequency audio data from ordinary application state.

Consider appropriate solutions such as:

- Dedicated telemetry subscriptions.
- External stores.
- Selective subscriptions.
- requestAnimationFrame-driven rendering.
- Refs for high-frequency values.
- Canvas rendering independent of React reconciliation.
- AudioWorklet processing where appropriate.
- Efficient typed-array data structures.

Select the approach that best fits the existing architecture.

Do not introduce unnecessary complexity.

## 2.2 Rendering Optimization

Optimize:

- Spectrum analyzer.
- Spectrogram.
- Waveform visualization.
- Peak meters.
- RMS meters.
- LUFS meters.
- Stereo meters.
- Frequency displays.
- Real-time processing indicators.

Requirements:

- Avoid unnecessary React reconciliation.
- Avoid repeated allocations in high-frequency rendering loops.
- Reuse buffers where practical.
- Avoid unnecessary canvas resizing.
- Prevent stale animation frames.
- Prevent duplicate event subscriptions.
- Cancel animation frames and release resources correctly.
- Ensure components clean up when unmounted.
- Prevent memory leaks.
- Avoid excessive CPU consumption.

Maintain accurate synchronization between audio playback and visual feedback.

## 2.3 Audio Thread Protection

Ensure that expensive processing does not unnecessarily block the browser's main UI thread.

Investigate whether appropriate operations can be moved into:

- AudioWorklet.
- Dedicated Web Workers.
- Existing native processing components.
- Other appropriate isolated execution environments.

Do not move operations blindly.

Preserve audio synchronization, processing order, and numerical accuracy.

Prevent:

- Audio dropouts.
- Buffer underruns.
- Clicks and pops.
- Playback interruptions.
- Recording instability.
- Excessive latency.
- Thread contention.

## 2.4 Performance Verification

Measure performance before and after implementation.

Where possible, record:

- Average CPU utilization.
- Peak CPU utilization.
- Main-thread execution time.
- React render frequency.
- Frame rate.
- Frame timing consistency.
- Memory consumption.
- Audio processing latency.
- Playback stability.
- Dropped frames.
- Audio buffer underruns.

Test under realistic conditions, including continuous playback, active visualization, and simultaneous mastering operations.

Do not invent benchmark results.

If a measurement cannot be collected, explicitly identify that limitation.

## ADDITIONAL REQUIREMENT: COMPLETE WEB APPLICATION PERFORMANCE AUDIT

Do not limit performance optimization to React telemetry.

Perform a comprehensive audit of the entire browser application.

Investigate:
- JavaScript execution bottlenecks.
- Excessive React rendering.
- Main-thread blocking.
- Long-running tasks.
- DOM complexity.
- Canvas rendering performance.
- Web Audio API scheduling.
- AudioWorklet performance.
- Memory consumption and garbage collection.
- Excessive event listeners.
- Network requests and API latency.
- Asset loading and bundle size.
- Unnecessary background processes.
- Animation and frame timing.
- Browser storage operations.
- Resource cleanup.

Use browser profiling and performance measurements wherever available.

Identify and prioritize the actual causes of sluggishness, stuttering, delayed interactions, and excessive resource consumption.

Optimize the entire web application, not just the audio visualizers.

The finished web application must remain responsive during continuous playback, recording, visualization, audio analysis, and AI mastering operations.

Test under realistic browser conditions and document measurable improvements.

Do not sacrifice audio quality, processing accuracy, or functionality for benchmark improvements.

---

# PART 3: NEW FEATURE - CHAIN WITH AI

## Feature Name

CHAIN WITH AI

## Core Concept

Implement a prominent, fully functional AI-powered mastering optimization button.

CHAIN WITH AI must transform SYN MASTER from a conventional mastering workstation with AI assistance into an intelligent, measurement-driven mastering system.

The feature must do more than recommend settings or generate a suggested plugin chain.

It must:

1. Analyze the source audio.
2. Identify measurable technical problems.
3. Determine appropriate corrective processing.
4. Construct or modify the actual mastering chain.
5. Render or process the audio.
6. Measure the resulting audio.
7. Compare results against appropriate targets.
8. Identify remaining problems.
9. Adjust processor parameters.
10. Repeat the process.
11. Validate the final result.
12. Present the completed chain and optimization report.

This is a CLOSED-LOOP AUTONOMOUS MASTERING OPTIMIZATION ENGINE.

Gemini provides intelligent analysis and decision-making.

The actual DSP engine performs the processing.

The measurement engine determines whether the adjustments worked.

The AI must never be allowed to declare success without supporting measurements.

---

# PART 4: INITIAL AUDIO ANALYSIS

Before modifying the mastering chain, analyze the source audio.

Extract actual measurements wherever supported by the existing audio engine.

Analyze the following:

## Loudness and Dynamics

- Integrated LUFS.
- Short-term LUFS.
- Momentary LUFS.
- Loudness range.
- True peak.
- Sample peak.
- Crest factor.
- RMS level.
- Dynamic range.
- Clipping.
- Excessive compression.
- Potential over-limiting.

## Frequency Analysis

- Overall frequency distribution.
- Sub-bass balance.
- Bass balance.
- Low-mid balance.
- Midrange balance.
- Upper-midrange balance.
- High-frequency balance.
- Spectral centroid.
- Spectral rolloff.
- Frequency masking.
- Excessive resonances.
- Muddy frequency regions.
- Harsh frequency regions.
- Unbalanced spectral energy.

## Stereo Analysis

- Stereo width.
- Left/right balance.
- Correlation.
- Phase compatibility.
- Mono compatibility.
- Potential phase cancellation.
- Excessive stereo widening.

## Audio Quality

- Distortion.
- Clipping.
- Unwanted noise.
- Excessive saturation.
- Unwanted pumping.
- Transient degradation.
- Unnatural dynamics.
- Potentially destructive processing.

Distinguish between objectively measurable problems and subjective mastering preferences.

Do not classify every unusual measurement as an error.

---

# PART 5: INTELLIGENT MASTERING PLAN

Once analysis is complete, Gemini must generate a structured optimization plan.

The plan must identify:

- Detected problem.
- Supporting measurement.
- Severity.
- Proposed correction.
- Relevant DSP processor.
- Parameter adjustments.
- Expected outcome.
- Potential side effects.
- Validation method.

Prioritize corrections according to their importance.

Do not automatically apply every available processor.

Use only the processing required by the actual audio.

The system must be capable of deciding that a processor is unnecessary.

For example, if the source already has balanced low frequencies, the AI should not modify them simply because an EQ is available.

---

# PART 6: VERIFIED DSP PROCESSOR INVENTORY

Before implementing AI-controlled processing, inspect the actual DSP engine.

Create a verified inventory of available processors and their capabilities.

For every processor, identify:

- Processor name.
- Processor identifier.
- Supported parameters.
- Parameter data types.
- Minimum and maximum values.
- Default values.
- Supported modes.
- Processing limitations.
- Whether it supports real-time adjustment.
- Whether it can be used during offline rendering.

Potential processor categories include:

- Parametric EQ.
- Dynamic EQ.
- High-pass filtering.
- Low-pass filtering.
- Compression.
- Multiband compression.
- Limiting.
- Clipping.
- Saturation.
- Harmonic excitation.
- Stereo imaging.
- Mid/side processing.
- Transient shaping.
- Loudness optimization.

These are categories to investigate, not permission to invent nonexistent processors.

Only implement AI control for processors that actually exist or are deliberately implemented as part of this engineering phase.

## Parameter Validation

Gemini must never directly execute arbitrary DSP instructions.

Create a validated interface between the AI decision-making layer and the DSP engine.

Requirements:

- Strict parameter schemas.
- Valid processor identifiers.
- Parameter range enforcement.
- Type validation.
- Finite numerical values.
- Safe defaults.
- Rejection of unsupported instructions.
- Prevention of invalid processor configurations.

All AI-generated processing instructions must pass validation before reaching the audio engine.

---

# PART 7: AUTOMATED CHAIN CONSTRUCTION

After generating the optimization plan, construct the mastering chain automatically.

The AI must determine:

- Which processors are necessary.
- Their processing order.
- Initial parameter settings.
- Gain staging between processors.
- Whether serial or parallel processing is appropriate.
- Whether multiband processing is necessary.
- Whether additional limiting is necessary.

Respect the existing signal flow and DSP architecture.

Do not duplicate processors unnecessarily.

Do not introduce excessive processing.

Maintain appropriate headroom throughout the chain.

Avoid unnecessary phase shifts, latency, distortion, and transient degradation.

Every inserted or modified processor must have a documented reason.

---

# PART 8: CLOSED-LOOP ITERATIVE OPTIMIZATION

This is the most important part of CHAIN WITH AI.

The system must actually process audio and evaluate the results.

## Optimization Cycle

Implement the following cycle:

ANALYZE
↓
IDENTIFY PROBLEMS
↓
GENERATE OPTIMIZATION PLAN
↓
CONFIGURE DSP CHAIN
↓
PROCESS / RENDER AUDIO
↓
MEASURE RESULT
↓
COMPARE AGAINST TARGETS
↓
IDENTIFY REMAINING PROBLEMS
↓
ADJUST PROCESSORS
↓
PROCESS AGAIN
↓
REPEAT
↓
FINAL VALIDATION

After every iteration:

1. Collect actual measurements.
2. Compare measurements against the original source.
3. Compare measurements against the selected mastering targets.
4. Identify improvements and regressions.
5. Determine whether another adjustment is justified.
6. Modify only relevant processor parameters.
7. Render another analysis pass.

Do not simply repeat the same AI request without incorporating new measurements.

Each iteration must use the actual results of the previous iteration.

## Optimization Intelligence

The AI must understand relationships between processing decisions.

Examples:

- EQ adjustments can change perceived loudness.
- Compression can alter transient behavior.
- Limiting can affect true peak and dynamic range.
- Saturation can introduce additional harmonics.
- Stereo widening can compromise mono compatibility.
- Excessive low-frequency energy can affect available headroom.
- Increasing loudness can compromise dynamics.

Avoid optimizing one measurement while damaging the overall master.

Use a multi-objective optimization strategy rather than treating every metric independently.

## Iteration Limits

Prevent endless optimization loops.

Implement:

- Configurable maximum iteration count.
- Processing-time limits.
- Improvement thresholds.
- Convergence detection.
- Plateau detection.
- Regression detection.
- Emergency stop conditions.

The system must stop when:

- Targets are satisfied.
- Improvement becomes negligible.
- Further processing compromises audio quality.
- A parameter reaches a safe operating limit.
- Processing fails.
- Measurements become invalid.
- The user requests cancellation.

Do not claim that all problems are resolved if some remain.

---

# PART 9: MASTERING TARGETS AND PROFILES

Do not assume every track should have identical mastering targets.

Allow optimization targets to reflect:

- Selected mastering profile.
- Intended musical genre.
- Desired loudness.
- Desired dynamic character.
- Delivery format.
- Streaming requirements.
- User-selected preferences.

Where supported, provide appropriate mastering profiles for different use cases.

Potential profiles:

- Streaming.
- Commercial loudness.
- Dynamic mastering.
- Cinematic.
- Electronic.
- Hip-hop.
- Pop.
- Acoustic.
- Vocal-focused.
- Custom.

Do not hardcode arbitrary loudness targets as universal requirements.

Use technically appropriate targets and make assumptions visible to the user.

The AI must distinguish between:

1. Technical errors.
2. Potential mastering problems.
3. Intentional creative characteristics.
4. User-defined preferences.

Never destroy intentional creative characteristics merely to achieve numerical perfection.

---

# PART 10: NON-DESTRUCTIVE PROCESSING AND SAFETY

The original audio must always remain recoverable.

Implement a non-destructive workflow.

Requirements:

- Preserve the original source audio.
- Never overwrite the original recording.
- Maintain snapshots of the mastering chain.
- Preserve processor parameters.
- Maintain an undoable history of AI changes.
- Support restoration of the previous chain.
- Support cancellation during optimization.
- Ensure partial optimization cannot leave the application in an inconsistent state.

## Transactional Iterations

Treat every optimization iteration as a transaction.

Before applying modifications:

1. Save the current known-good chain state.
2. Record the proposed changes.
3. Validate all parameters.
4. Apply the changes.
5. Process the audio.
6. Measure the result.
7. Compare against previous results.

If processing fails, measurements become invalid, or audio quality deteriorates beyond configured tolerances:

- Reject the change.
- Restore the previous known-good chain.
- Record the failure.
- Continue only if safe.

Prevent unstable oscillation between parameter values.

Do not allow repeated AI adjustments to accumulate uncontrollably.

---

# PART 11: USER INTERFACE

Integrate CHAIN WITH AI into the existing SYN MASTER mastering interface.

The button must be prominent and consistent with the application's existing visual design.

Do not create a disconnected demo screen or separate application.

## Main Button

CHAIN WITH AI

The button must initiate actual optimization.

Provide appropriate states:

- Ready.
- Analyzing.
- Planning.
- Building chain.
- Processing.
- Measuring.
- Optimizing.
- Validating.
- Completed.
- Stopped.
- Failed.

## Optimization Dashboard

While optimization is running, display:

- Current stage.
- Current iteration.
- Maximum iterations.
- Progress indicator.
- Current processor being adjusted.
- Reason for each adjustment.
- Detected issue.
- Current measured value.
- Target value.
- Previous measurement.
- Current measurement.
- Improvement or regression.

The interface must remain responsive throughout optimization.

Do not freeze the application while processing.

## User Controls

Provide:

- Start optimization.
- Stop optimization.
- Cancel optimization.
- Undo AI changes.
- Accept final chain.
- Restore previous chain.
- Review optimization history.

The user must retain control over whether the resulting chain is accepted.

## Final Optimization Report

At completion, display:

- Original audio measurements.
- Final audio measurements.
- Problems detected.
- Problems resolved.
- Problems partially resolved.
- Problems intentionally left unchanged.
- Processors inserted.
- Processors modified.
- Parameters changed.
- Number of iterations.
- Overall optimization result.
- Remaining recommendations.

Show measurable before-and-after improvements.

Do not fabricate improvement percentages.

---

# PART 12: GEMINI INTEGRATION

Inspect the existing Gemini implementation before modifying it.

Preserve the existing server-side API architecture.

Gemini must operate as the intelligent decision-making layer.

The DSP engine must remain responsible for audio processing.

The measurement engine must remain responsible for validating results.

## AI Communication

Use structured, schema-validated responses.

The AI response should contain:

- Analysis interpretation.
- Identified problems.
- Optimization priorities.
- Processor selections.
- Proposed parameter changes.
- Reasoning summaries.
- Expected outcomes.
- Validation requirements.
- Next optimization decision.

Do not expose chain execution to unrestricted AI-generated code.

Do not execute arbitrary scripts or commands returned by Gemini.

## API Security

NON-NEGOTIABLE:

- Keep GEMINI_API_KEY server-side.
- Never expose API keys in frontend JavaScript.
- Never embed secrets in client-side configuration.
- Preserve existing request validation.
- Preserve request-size limits.
- Preserve rate limiting.
- Sanitize client-facing errors.
- Avoid logging credentials or sensitive audio data.
- Validate all AI responses before processing.
- Prevent malformed responses from reaching the DSP engine.

Do not remove existing security safeguards to simplify integration.

## Actual API Verification

A configured environment variable does not prove that Gemini integration works.

Where authorized and safe, perform a genuine API smoke test.

Verify:

- Credential acceptance.
- Model availability.
- SDK compatibility.
- Response structure.
- Error handling.
- Timeout handling.
- Invalid response handling.

Do not expose the API key during testing.

If an actual Gemini request cannot be performed, explicitly report that it remains unverified.

---

# PART 13: ACCOUNT-FREE ARCHITECTURE

SYN MASTER MUST REMAIN ACCOUNT-FREE.

The user has explicitly decided:

- NO ACCOUNTS.
- NO REGISTRATION.
- NO LOGIN.
- NO USER PROFILES.
- NO OAUTH.
- NO FIREBASE AUTH.
- NO SUPABASE AUTH.
- NO MULTI-USER SAAS ARCHITECTURE.

SYN MASTER is a single-user mastering workstation.

Do not introduce account systems or authentication flows.

However, account-free does not mean that a remote API endpoint should be left unrestricted.

Investigate appropriate private deployment protection.

Potential approaches include:

- Local-only operation.
- Deployment-level access restrictions.
- Private network access.
- A protected reverse proxy.
- An appropriately configured private gateway.

Do not assume a specific hosting feature is available without verifying it.

Do not place static access credentials in browser code.

Do not make deployment changes without authorization.

---

# PART 14: PERFORMANCE AND OPTIMIZATION COORDINATION

The performance overhaul and CHAIN WITH AI must work together.

AI optimization may involve repeated audio processing and analysis.

Ensure that this does not interfere with:

- Playback.
- Recording.
- Real-time monitoring.
- Visualization.
- User interaction.
- Existing mastering operations.

Where possible, perform offline optimization without interrupting active playback.

Use appropriate resource management and cancellation mechanisms.

Prevent multiple optimization sessions from running simultaneously unless the architecture explicitly supports them.

Provide clear handling when the user changes the source audio or mastering settings during an optimization session.

Detect stale optimization results and prevent them from being applied to a different audio source.

The application must never silently apply an optimization generated for an earlier version of the audio.

---

# PART 15: TESTING AND QUALITY ASSURANCE

Testing is mandatory.

Do not treat successful compilation as proof that the feature works.

## 15.1 Existing Functionality

Verify that existing functionality remains intact.

Test:

- Audio import.
- Audio playback.
- Audio recording.
- Audio monitoring.
- Waveform rendering.
- Spectrum analysis.
- Spectrogram rendering.
- Audio enhancement.
- EQ processing.
- Compression.
- Limiting.
- Presets.
- Mastering controls.
- Export.
- Existing AI functionality.
- Application navigation.

## 15.2 Performance Tests

Test:

- Continuous playback.
- Active meters.
- Active visualizers.
- Simultaneous processing.
- Repeated component mounting and unmounting.
- Long-running sessions.
- Memory stability.
- Cancellation and cleanup.

## 15.3 CHAIN WITH AI Tests

Test with representative audio containing:

- Clipping.
- Excessive low-frequency energy.
- Harsh high frequencies.
- Excessive dynamic compression.
- Insufficient loudness.
- Excessive loudness.
- Stereo phase problems.
- Balanced audio that should require minimal intervention.

Verify that the system:

- Detects actual problems.
- Selects appropriate processors.
- Generates valid parameters.
- Processes audio.
- Measures actual output.
- Makes iterative adjustments.
- Detects regressions.
- Stops when appropriate.
- Preserves the original audio.
- Restores previous states.
- Produces an accurate final report.

Include negative tests for:

- Invalid AI responses.
- Unsupported processors.
- Out-of-range parameters.
- NaN and infinite values.
- Processing failures.
- Invalid audio measurements.
- Timeouts.
- User cancellation.
- Source audio changing during optimization.
- Repeated optimization requests.

## 15.4 Regression Testing

Run the complete available:

- Unit tests.
- Integration tests.
- TypeScript checks.
- Production builds.
- Native builds where applicable.
- Existing CI workflows.

Add tests for new functionality.

Do not remove existing tests to make the build pass.

Fix failures caused by the implementation.

Do not conceal unrelated pre-existing failures.

---

# PART 16: INDEPENDENT VERIFICATION

After implementation, perform a second independent review.

Actively attempt to disprove that the changes work.

Look for:

- Audio regressions.
- Incorrect measurements.
- False optimization success.
- DSP parameter instability.
- Incorrect processor ordering.
- Race conditions.
- Memory leaks.
- Stale subscriptions.
- Excessive rendering.
- Unhandled exceptions.
- Broken undo behavior.
- Incorrect restoration.
- API security weaknesses.
- Exposed credentials.
- Invalid AI responses.
- Incomplete cancellation.
- Stale audio results.
- Performance regressions.

Re-run relevant tests after correcting discovered issues.

Do not claim success merely because the code looks correct.

Distinguish between:

- Implemented.
- Unit tested.
- Integration tested.
- Runtime tested.
- Performance measured.
- Independently verified.
- Not yet verified.

---

# PART 17: GIT AND CHANGE MANAGEMENT

Continue using the existing engineering branch.

Requirements:

- Do not work directly on main.
- Do not merge the existing pull request.
- Do not publish the application.
- Do not modify the live Google AI Studio deployment.
- Preserve existing work.
- Keep changes organized.
- Use separate commits for performance optimization and CHAIN WITH AI where practical.
- Ensure commits contain only intentional changes.

After implementation:

1. Inspect the complete diff.
2. Check for unintended modifications.
3. Run relevant tests.
4. Verify the final branch and commit history.
5. Confirm the existing PR reflects the intended changes if the branch is connected to it.

Do not claim that changes are live when they exist only in GitHub.

---

# PART 18: FINAL DELIVERY REPORT

When the engineering work is complete, provide a detailed report containing:

## A. Performance Optimization
- Original bottlenecks.
- Root causes.
- Files modified.
- Architectural changes.
- Before-and-after measurements.
- Remaining performance limitations.

## B. CHAIN WITH AI
- Implemented functionality.
- AI decision-making architecture.
- DSP processors supported.
- Measurement systems used.
- Optimization loop behavior.
- Iteration limits.
- Safety mechanisms.
- Undo and restoration functionality.
- User interface components.

## C. Verification
- Tests executed.
- Test results.
- Build results.
- Runtime verification.
- Performance benchmarks.
- Regression checks.
- Failures discovered and corrected.

## D. Security
- Gemini key handling.
- API validation.
- Rate limiting.
- Deployment access considerations.
- Any remaining security concerns.

## E. Git Status
- Branch name.
- Commit hashes.
- Changed files.
- Pull request status.
- Confirmation that main was not modified.
- Confirmation that the live deployment was not modified.

## F. Outstanding Work
Clearly identify anything incomplete, blocked, simulated, or not independently verified.

Never describe a placeholder as a completed feature.

Never report fabricated measurements.

Never claim an integration works without actual verification.

---

# FINAL ENGINEERING DIRECTIVE

Build this properly.

SYN MASTER should become a responsive, professional-grade mastering workstation with an intelligent autonomous mastering system.

The performance improvements must preserve the audio experience.

CHAIN WITH AI must make real DSP changes, process real audio, measure the actual output, and intelligently refine the result.

The AI must be able to recognize when no adjustment is necessary, when an adjustment is harmful, and when further optimization would compromise the music.

The goal is not to make every numerical measurement perfect.

The goal is to produce the best technically sound master possible while preserving the artistic character of the original recording.

READ EVERYTHING.
INSPECT THE EXISTING IMPLEMENTATION.
UNDERSTAND THE DEPENDENCIES.
PLAN THE CHANGES.
IMPLEMENT IN CONTROLLED STAGES.
TEST THE ACTUAL FUNCTIONALITY.
MEASURE THE RESULTS.
INDEPENDENTLY CHALLENGE THE RESULTS.
FIX WHAT FAILS.
VERIFY AGAIN.

DO NOT RUSH.

DO NOT TAKE SHORTCUTS.

DO NOT REMOVE FUNCTIONALITY TO MAKE IMPLEMENTATION EASIER.

DO NOT STOP AT A VISUAL MOCKUP.

DO NOT STOP AT A SUCCESSFUL BUILD.

DELIVER WORKING, TESTED, VERIFIED ENGINEERING.

**SYN MASTER: HEAR MORE. MASTER BETTER.**