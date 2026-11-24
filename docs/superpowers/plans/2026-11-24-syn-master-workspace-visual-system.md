# SYN MASTER Workspace Visual System Implementation Plan

> **For agentic workers:** Execute inline on `main`, as explicitly directed by the user. Do not create a branch or worktree.

**Goal:** Carry the approved premium SYN MASTER visual language across every workspace so the desktop application feels like one coherent professional mastering instrument, with real controls and honest data states.

**Architecture:** Add a shared workspace identity header with workspace-specific SVG instrumentation, while preserving the AI Director's existing purpose-built orb/pipeline hero. Refine individual empty states and existing panels without replacing DSP, AI, QC, reference, plugin-host, or export behavior. Keep graphics in SVG/CSS so they are crisp, accessible, fast, and can later be bound to live telemetry.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS 4, Lucide icons, Playwright responsive smoke checks.

**Spec:** User-approved SYN MASTER visual direction in conversation: premium dark navy/black, metallic gold accents, electric blue signal graphics, coherent horizontal navigation, desktop-first control room, clear mobile adaptation, functional rather than decorative-only workspaces.

## Global Constraints

- Work directly on `main`; do not create branches.
- Preserve DSP algorithms, mastering logic, project data, export behavior, host integration, and existing user workflows.
- Do not fabricate measurements. Idle graphics must be labeled as illustrative or awaiting source audio.
- Maintain keyboard accessibility and responsive behavior at 360, 375, 412, 1024, and 1440 px.
- No new runtime dependencies.
- Keep mobile import-first behavior and desktop control-room landing view.
- Use blue for signal/analysis and gold for premium hardware/action accents.

## Review Focus

- No source loaded: AI, Lab, Battle, Reference, QC, Stems and Plugin Manager must remain navigable and show a useful, truthful state.
- Loaded source: section graphics must not imply preview values are actual telemetry.
- Mobile: decorative SVGs and section headers must not create horizontal overflow.
- Navigation: selected workspace must remain correctly identified after selecting advanced workspaces.
- Existing analysis, audition, AI, plugin host, and QC actions must remain intact.

---

### Task 1: Shared workspace identity and instrumentation

**Files:**
- Create: `src/components/WorkspaceHero.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Test: `scripts/responsive-layout-check.mjs`

**Interfaces:**
- Consumes: `WorkspaceTab`, current `activeTrack` presence, existing app layout.
- Produces: `WorkspaceHero({ workspace, hasTrack })` for Lab, Stems, Battle, Reference, QC and Plugins. AI Director retains its native orb/pipeline hero. All workspace identity elements use `data-testid="workspace-hero"` and workspace-specific graphics.

- [x] Add Playwright assertions for all seven non-studio workspace headers and the AI pre-import state.
- [x] Run responsive CI and observe the expected missing-header failure.
- [x] Implement the shared component with distinct visual motifs for Lab, Stems, Battle, Reference, QC and Plugins; retain AI Director's native hero.
- [x] Integrate the header without moving or replacing existing functional workspace content.
- [x] Add responsive styles and truthful idle/source status labels.
- [x] Run the complete web CI.

### Task 2: Section-specific empty states and visual hierarchy

**Files:**
- Modify: `src/components/SynLabView.tsx`
- Modify: `src/components/BattleModeView.tsx`
- Modify: `src/components/ReferenceAndQcViews.tsx`
- Modify: `src/components/StemIntelligencePanel.tsx`
- Modify: `src/components/PluginManagerView.tsx`
- Modify: `src/index.css`
- Test: `scripts/responsive-layout-check.mjs`

**Interfaces:**
- Consumes: existing view props and existing action callbacks.
- Produces: section-specific, useful pre-import states; consistent blue signal / gold action hierarchy; no fake analysis values.

- [x] Add targeted browser assertions for each no-source empty state.
- [x] Verify expected failure before implementation.
- [x] Refine empty states with purpose-built SVG/CSS instrument art and direct next actions.
- [x] Preserve existing loaded-source controls and results.
- [x] Run complete web CI and inspect responsive logs.

### Task 3: Navigation, library and cross-workspace consistency

**Files:**
- Modify: `src/components/WorkspaceNavigation.tsx`
- Modify: `src/components/LeftLibraryPanel.tsx`
- Modify: `src/components/MasteringRack.tsx`
- Modify: `src/index.css`
- Test: `scripts/responsive-layout-check.mjs`

**Interfaces:**
- Consumes: existing navigation callbacks, rack state, library callbacks.
- Produces: consistent selected states, visual tokens and readable section hierarchy without changing processing behavior.

- [x] Add regression checks for navigation state and library controls.
- [x] Verify expected failure before implementation.
- [x] Refine nav, library and rack presentation with blue signal states and restrained gold action states.
- [x] Run complete web CI.

### Task 4: Whole-application review

- [x] Re-read all changed files and the complete diff through GitHub.
- [x] Verify current `main` head and no unintended files or branch changes.
- [x] Run latest Web CI and inspect all jobs/logs.
- [x] Check Windows native workflow status separately; report it independently from web UI verification.
- [x] Record any unverified visual/manual-audio acceptance items honestly.


## Execution notes

- All code changes were made directly on `main`; the branch list was verified to contain only `main`.
- AI Director uses its native orb and pipeline rather than a second duplicate workspace hero.
- Each specialist workspace now has an honest no-source/no-host state and a dedicated instrument graphic.
- The Audio Library, Mastering Rack and all specialist workspaces carry the shared instrument skin.
- Active primary navigation and library selection are exposed accessibly. The advanced drawer is layered above transport/A-B controls.
- The Analysis Lab tabs and AI signal visualization remain usable on narrow mobile widths.
- Latest completed web verification at the time of this plan update: workflow [45461173378](https://github.com/LILSYNNOFFICIAL/SYN-MASTER/actions/runs/45461173378), success on source revision `d8b2116a`.
- Manual pixel-level comparison against the owner's reference screenshots and physical Android acceptance remain open. Automated browser checks do not establish pixel-perfect visual fidelity or real-audio acceptance.
- Windows native workflow `45460632844` was checked separately: CMake configuration succeeded; native host/scanner/worker/VST3/core-test compilation was still in progress at the last status check.
