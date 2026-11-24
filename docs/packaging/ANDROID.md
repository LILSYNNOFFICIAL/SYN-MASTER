# Android delivery plan

## Current deliverable

SYN MASTER remains a browser-first application. The web manifest and service worker make the hosted application installable as a PWA in supporting browsers. The worker caches only same-origin navigation and ordinary static assets; it deliberately excludes `/api/`, ONNX/ORT, Demucs and large model payloads. A cached shell does not guarantee that offline mastering or model inference will work.

## URL-backed Android wrapper

The wrapper must load the same hosted URL and must not fork the React UI, DSP engine, project format, or mastering authority.

1. Complete physical Android Chrome acceptance: import/local file selection, playback, timeline seek, touch EQ editing, FX-window interaction, Fix All, cancellation/rollback, export/download, background/resume, and a near-six-minute project.
2. Evaluate a Trusted Web Activity (TWA) first because it uses the browser rendering engine and keeps the hosted URL as the source of truth.
3. Use a conventional WebView only if a required native capability cannot be delivered through PWA/TWA, with explicit file chooser and download handling.

## TWA prerequisites

- A stable HTTPS origin controlled by the project owner.
- A final Android package ID and signed release certificate.
- The certificate SHA-256 fingerprint.
- A hosted `/.well-known/assetlinks.json` binding that package and fingerprint to the origin.
- A release build and physical-device acceptance.

Do not add a placeholder Digital Asset Links file or claim wrapper verification before package ID, signing fingerprint and hosted origin are real. Repository GitHub access cannot deploy files or secrets to the AI Studio hosted origin.
