# Third-Party Notices

## Native VST companion (`native/`)

The Windows VST companion is licensed AGPL-3.0-only (`native/LICENSE`; see the repo-root `LICENSE`
for scope). Its third-party components are listed, with licences, in
[`native/companion-release/THIRD_PARTY_NOTICES.txt`](../native/companion-release/THIRD_PARTY_NOTICES.txt),
which ships in every release zip:

- JUCE 8.0.17-security: AGPLv3 (used under that option) or commercial.
- Steinberg VST3 SDK 3.8.0 (bundled in JUCE 8.0.17-security): MIT.
- IXWebSocket 11.4.5: BSD-3-Clause.
- nlohmann/json 3.11.3: MIT.
- SQLite 3.47.2: public domain.

## Web app

## ONNX float64 graph compatibility helper

The ONNX protobuf float64-to-float32 rewrite in `src/dsp/onnxFloat64Fix.ts` is adapted from:

- Project: [Gerschwin/steminize](https://github.com/Gerschwin/steminize)
- File: `src/engine/fixfloat64.ts`
- Copyright: Copyright (c) 2026 Neil
- License: MIT

MIT License

Copyright (c) 2026 Neil

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
