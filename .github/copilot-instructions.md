# SYN-MASTER project instructions

- This is a React 19 + TypeScript + Vite mastering workstation with an Express server and a Windows C++/JUCE companion host. Preserve the browser-first product and Google AI Studio compatibility.
- Keep entry files (`index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `vite.config.ts`, `server.ts`, `metadata.json`) and assets under `public/`. Do not add a backend service or move Gemini credentials into client code.
- Keep `GEMINI_API_KEY` server-only. Use `process.env.GEMINI_API_KEY`; never add `VITE_` variables or client-side secrets.
- Treat [README.md](../README.md) as the living product specification. Read it before major work and update its status/worklist as implementation progresses.
- Preserve DSP defaults and the Fix-All verification loop unless the task explicitly requires a change. Measured, rendered output is the pass criterion: do not weaken objective gates or regression guards to make tests pass.
- Fades run after the effects chain; limiter/ceiling decisions see the unfaded signal. Export, preview, playback, and Fix-All must retain the same finalized offline chain.
- Put browser audio rendering in `src/dsp/` and `src/director/`; keep UI orchestration in `src/App.tsx` or purpose-built components. Reuse `src/types/mastering.ts` processor parameter types.
- Keep the black-and-gold/blue instrument design consistent. Use existing Tailwind v4/custom CSS and `lucide-react`; do not add a heavy component library.
- Avoid full-track render copies in worker paths. Preserve ownership contracts and bounded scratch buffers for long/mobile tracks.
- Commit directly to `main` in small conventional commits. Never create branches or pull requests. Update the README ledger for meaningful code changes.
- Before every push run `npm run lint`, `npm run build`, and `npx tsx --test` on touched tests. Also run `npm test` for affected shared DSP/director changes.
- Native companion work belongs in `native/`; the companion remains loopback-only on HTTP `127.0.0.1:47832` and WS `127.0.0.1:47833`. Do not treat native executables as the complete workstation EXE.
