# AI Stem Separation

## Engine

SYN-MASTER uses the single-model HT-Demucs ONNX export from StemSplit:

- Model: `StemSplitio/htdemucs-onnx`
- Pinned revision: `d54ed9eb60e258ea82131c6ee14578628816456a`
- Artifact: `htdemucs_fp16weights.onnx` (approximately 166 MB)
- SHA-256: `d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a` (verified before inference)
- Runtime: `onnxruntime-web` in a dedicated browser worker
- Preferred execution provider: WebGPU; portable fallback: WASM
- Model input: 44.1 kHz stereo float32, fixed 343,980-sample (7.8-second) windows
- Model output: four stereo float32 stems in the order drums, bass, other, vocals
- Session handoff: each stem is resampled to the active SYN-MASTER session sample rate before it is added to the timeline

This is the standard single-model HT-Demucs export, not the higher-quality four-model HT-Demucs FT bag. The single-model choice reduces first-use download and inference cost. It is not a claim that the model matches commercial separation services.

## Processing path

1. The browser decodes the selected mono/stereo source mix.
2. `OfflineAudioContext` resamples it to 44.1 kHz and duplicates mono to stereo.
3. A dedicated worker loads the pinned ONNX model and runs inference.
4. The ONNX protobuf is patched in memory from float64 to float32 for browser-runtime compatibility; the original 166 MB model remains unchanged on the CDN/cache.
5. ONNX graph optimization is disabled to avoid large optimization-time memory spikes.
6. Long tracks are processed in 7.8-second windows with quarter-window linear overlap-add.
7. Four reconstructed stereo stems are handed directly to Stem Intelligence at sample offset zero.

The overlap window leaves the outer edges unattenuated and crossfades only internal overlaps. The shared overlap weights are accumulated once per chunk and used to normalize each output channel.

## Privacy and resources

Audio samples are transferred to the local worker and are not sent to a SYN-MASTER server. The browser downloads the model from Hugging Face on first use, verifies its SHA-256 digest, and stores the verified source artifact in Cache Storage (`syn-master-models-v1`) when quota and browser policy allow. Later sessions can reuse the cached model without another network download.

The four output stems are uncompressed float32 stereo buffers. SYN-MASTER estimates their memory requirement before inference and applies a device-memory-based guard. The ONNX runtime itself can require substantial additional working memory. WebGPU is preferred where available; WASM fallback may be slower and can be memory intensive. Very long files or low-memory devices may be unable to complete separation.

Cancellation is cooperative: the worker stops after the current model inference call returns. No partial stems are added to the project.

## Model license and attribution

The ONNX model repository declares MIT licensing and attributes the original HT-Demucs model to Meta AI Research / the Demucs authors. The ONNX export and packaging are attributed to StemSplit. The browser float64 compatibility helper is adapted from Gerschwin/steminize under MIT; see [third-party notices](THIRD_PARTY_NOTICES.md). See the [model card](https://huggingface.co/StemSplitio/htdemucs-onnx) and [original Demucs repository](https://github.com/facebookresearch/demucs).

The model card's licensing statement should not be treated as a legal opinion about all training-data rights. The upstream training-data terms and their implications for commercial distribution of model weights may require separate legal review before commercial release.

## Validation boundary

Unit tests cover chunk planning, overlap windows, boundary preservation, overlap-add reconstruction, protobuf float64 conversion, and buffer bounds. A real browser-worker smoke test loaded the pinned model and separated a synthetic 7.8-second stereo signal into four finite outputs with the expected sample count. CI type-check and production-build checks validate the browser-worker bundle.

A synthetic smoke test does not prove real-song separation quality. Cache Storage persistence and cancellation during model preparation were also checked in a browser, and the browser resampler was checked from 44.1 kHz to 48 kHz with a 440 Hz test tone. A release candidate still needs real-song listening tests, target-device performance checks, long-file memory tests, and comparison against known reference stems.
