# 02 — Source Project Audit

**Read this before estimating anything.** VerseSync is not a greenfield build; it is a
composition of two working systems plus one genuinely new middle layer. This document records
what was found in each, file by file, and classifies every part as **reuse as-is**, **reuse
with changes**, or **gap — must be built**.

Audit performed against:
- `VerseFlow` @ `aa7b915` (main)
- `Faster-Whisper-Transcriber` @ `8d46a09` (main)

---

## Part 1 — VerseFlow

A CEP panel for Premiere Pro 2026 (Windows) that reads a scripture `.txt`, maps two fields of
a `.mogrt`, and inserts one graphic per scripture back-to-back from the playhead. Roughly
1,500 lines of implementation plus a 1,900-line planning package that is unusually complete
and should be treated as prior art, not re-derived.

### 1.1 What is directly reusable

| Asset | Where | Verdict |
|-------|-------|---------|
| **The MOGRT fill technique** | `jsx/VerseFlow.jsx` `_setTextField()` | **Reuse as-is.** Read the param's value, `JSON.parse`, set `textEditValue` **and** `fontTextRunLength`, `setValue(json, true)`. Omitting `fontTextRunLength` is documented as the single most common cause of silent failure. |
| **Index-based field targeting** | `_iterateProperties()`, `mapping.referenceIndex` / `bodyIndex` throughout | **Reuse as-is.** The reference template exposes two fields both named `Text`; `getParamForDisplayName` is ambiguous. Targeting by index is correct and VerseSync must keep it. |
| **Three-strategy field detection** | `_iterateProperties()` | **Reuse as-is.** `propertyType === 6`, then `=== 5`, then a `getValue()` probe for the substring `textEditValue`. This was hard-won across Premiere builds — do not simplify it. |
| **Group-node handling** | same | **Reuse as-is.** Types `10` and `4` are group/folder nodes; they set the current group label rather than being fields. |
| **Ticks helpers** | `js/duration.js`, `jsx/VerseFlow.jsx` | **Reuse as-is.** `254016000000` ticks/sec; ticks passed as **strings** to dodge float representation issues. |
| **Duration model** | `js/duration.js` | **Reuse as-is** for the PARAPHRASE case. 160 wpm, +1.5 s animation pad, clamped 3–20 s, rounded to 0.1 s. Client-approved constants. |
| **Undo grouping** | `VF.insertBatch` | **Reuse as-is.** `app.beginUndoGroup` / `endUndoGroup` around the whole batch, every call individually try-wrapped. |
| **Bridge conventions** | `js/bridge.js`, `docs/planning/06-extendscript-api.md` | **Reuse as-is.** Every host function returns a JSON string `{ok:true,data}` or `{ok:false,error}`; args passed as a JSON string; everything namespaced. The host never throws across the bridge. |
| **Explicit JSX load** | `VFBridge.loadJSX()` called at init | **Reuse as-is.** Bypasses Premiere's `ScriptPath` cache, which can serve a stale host script. A real bug fix, easily lost in a rewrite. |
| **ES3 JSON polyfill** | top of `VerseFlow.jsx` | **Reuse as-is.** Premiere 2026's ExtendScript engine has no native `JSON`. ASCII-only source, deliberately. |
| **`var fn = function(){}` convention** | documented in the file header | **Reuse as-is.** `$.evalFile()` does not hoist function *declarations* into persistent global scope in this engine. Violating this produces "undefined is not a function" at call time, not load time. |
| **CEP file dialogs** | `js/main.js` `pickFileCEP()` | **Reuse as-is.** `window.cep.fs.showOpenDialog`, deliberately **not** ExtendScript `File.openDialog`, which fails in Premiere 2026. |
| **Progress via CSXS events** | `CSXSEvent` `com.verseflow.progress` | **Reuse with rename.** Same mechanism, `com.versesync.progress`. |
| **Scratch-insert field discovery** | `VF.getMogrtFields` | **Reuse as-is.** Insert one instance past the sequence end inside an undo group, enumerate, remove. Requires an open sequence — keep the error message. |
| **Manifest / debug-mode install** | `CSXS/manifest.xml`, `.debug`, README | **Reuse as pattern.** New bundle id `com.versesync.panel`, new debug port. |

### 1.2 What must change

| Area | VerseFlow today | VerseSync needs | Impact |
|------|-----------------|-----------------|--------|
| **Placement model** | `insertBatch` keeps a running `cursor`, advancing by each item's duration from the playhead. Clips are inherently contiguous. | Each cue carries its own absolute `atTicks`. Clips are sparse and non-contiguous. | `insertBatch` is replaced by `VS.insertCues`. This is the single most important behavioural change and the reason `VF.insertOne` — which already takes an `atTicks` — is the closer starting point. |
| **Insert-at-arbitrary-time semantics** | Never exercised: inserts always land past existing content on a fresh region. | Cues land in the middle of a populated track. Must confirm `importMGT` **overwrites** rather than **inserts-and-ripples**. | **Spike T-03.** If it ripples, fall back to inserting on an empty track, or to `overwriteClip` with a pre-rendered asset (VerseFlow's documented Option B). |
| **Frame snapping** | Absent. Durations are float seconds → ticks; nothing aligns to frames. | Every anchor and duration snapped to whole frames via `sequence.timebase`. | New helper in the host and in the Python timing module. |
| **Sequence introspection** | `getSequenceInfo` returns name, video track count, playhead ticks. | Also `timebase` (ticks/frame), frame rate, `zeroPoint`, sequence end. | Small extension to an existing function. |
| **Source→sequence mapping** | Does not exist — VerseFlow has no concept of source media. | New `VS.getMediaSegments` walking every track item, matching `projectItem.getMediaPath()`. | **New host function.** See [08](08-premiere-host-api.md) §4. |
| **Input** | A hand-authored `.txt` parsed by `js/scripture-parser.js`. | A Cue Document from the sidecar. | `scripture-parser.js` is **not** reused for input — but see below. |
| **Preview** | HTML/CSS lower-third mock of the first scripture. | A review *list*, not a single preview. | `js/preview.js` shrinks to an optional per-row expansion; the review list is new. |
| **State** | Flat state + `localStorage` mapping persistence. | Adds a cue collection with per-row edit state, plus job lifecycle. | `state.js` grows substantially; keep the persistence pattern. |

`js/scripture-parser.js` deserves a note: it parses `<reference line> / <verse lines> /
<blank>` blocks with the regex
`^((?:\d+\s+)?[A-Za-z][A-Za-z ]*?\s+\d+:\d+(?:-\d+)?)\s*\(([A-Za-z0-9]+)\)\s*$`. VerseSync
does not use it for input, but its **output shape is the interop contract** — the body format
(verse lines joined by single spaces, verse numbers retained) and the reference format
(`Book C:V-V (TRANS)`) are exactly what [06](06-bible-text-service.md) must reproduce, so a
Cue Document and a hand-authored VerseFlow `.txt` produce identical graphics. Keeping that
identical is a requirement (FR-4.2, FR-4.3), and it is also what makes a `.txt` export a
viable escape hatch.

### 1.3 Known issues found during the audit

Not blockers, but worth knowing before touching this code:

- **`_setClipDuration` writes `clip.end` without moving `clip.start`.** Fine for contiguous
  placement; when placing sparsely into a populated track, extending `end` may collide with
  the next existing clip. Behaviour must be characterised in spike T-03.
- **Tick arithmetic is plain `Number`.** VerseFlow's own risk R4 notes timelines beyond
  ~2.5 hours exceed `Number.MAX_SAFE_INTEGER`. A 45-minute sermon is comfortably inside that,
  but VerseSync computes many more tick values, so centralise the math (as VerseFlow intended)
  and keep string-based addition available.
- **`insertBatch` advances `cursor` even for failed items** (`js/../jsx` failure path). Correct
  for contiguous layout; irrelevant once each cue carries an absolute time — but do not copy
  the pattern blindly into `VS.insertCues`.
- **`applySmartDefaults` regexes on group names** (`/descr|caption|sub|credit|author/` for the
  reference field, `/title|main|quote|body/` for the body) are tuned for `AV_Quote_04.mogrt`.
  Keep them; they are a good default and cost nothing when wrong.
- **The `.mogrt` binary is not in the repo** (the client declined). Every spike needs it
  obtained separately and placed at `assets/test/AV_Quote_04.mogrt`. Same applies to VerseSync.
- **The README documents `jsx/modules/util.jsx` and `jsx/modules/mogrt.jsx`**, but the code was
  consolidated into a single `jsx/VerseFlow.jsx` to avoid `#include` path resolution problems
  in Premiere 2026. The consolidation is correct; the README is stale. **VerseSync must keep
  the host as one file for the same reason.**

### 1.4 The planning package — treat as prior art

`VerseFlow/docs/planning/` contains sourced Adobe research that VerseSync depends on and must
not re-derive. In particular:

- **`02-adobe-research.md`** — the API fact sheet, the `textEditValue`/`fontTextRunLength`
  gotcha, why field discovery inserts to scratch, and why CEP rather than UXP.
- **`11-alternative-approaches.md`** — the investigation showing that scripting native Premiere
  text graphics is **not possible**; the real trade space is "MOGRT vs. bring-your-own-rendered
  asset". This is VerseSync's fallback plan too, and it is already costed.
- **`09-decisions-and-risks.md`** — risks R1 (ExtendScript end-of-support ~Sept 2026), R2
  (MOGRT text write must be validated on the real template), R7 (duplicate field names). All
  three are inherited by VerseSync verbatim.
- **`10-template-reference.md`** — the anatomy of `AV_Quote_04.mogrt`: AE-authored, 1920×1080,
  blue `#21ACE2` band, two `Text` fields in groups `Title Main` (← body) and `Description`
  (← reference).

---

## Part 2 — Faster-Whisper-Transcriber

A PySide6 desktop app wrapping `faster-whisper` / CTranslate2 with CUDA support. ~2,600 lines.
Records or opens audio, transcribes, and puts the text on the clipboard.

### 2.1 What is directly reusable

| Asset | Where | Verdict |
|-------|-------|---------|
| **Model loading** | `core/models/loader.py` | **Reuse as-is.** `load_model()` builds the CTranslate2 repo string (`ctranslate2-4you/whisper-{name}-ct2-{quant}`, with a `distil-whisper-` special case) and constructs `WhisperModel`. Clean, no Qt dependency. |
| **CUDA path setup** | `core/cuda_setup.py`, called before any Qt import in `main.py` | **Reuse as-is.** Ordering matters — the sidecar must call it first too. |
| **Quantization capability probe** | `core/quantization.py` | **Reuse as-is.** `ctranslate2.get_supported_compute_types()` per device, excluding int8/int16 variants. |
| **Model metadata table** | `core/models/metadata.py` | **Reuse with additions.** Model list, translation support, per-model quantization overrides. VerseSync adds a `word_timestamp_quality` field — see 2.2. |
| **Config manager** | `config/manager.py` + `config.yaml` | **Reuse as pattern.** YAML with defaults and a cache. VerseSync extends the schema rather than forking it. |
| **Temp file manager** | `core/temp_file_manager.py` | **Reuse as-is.** Reference-counted temp files with cleanup on exit. |
| **Logging config** | `core/logging_config.py` | **Reuse as-is.** |
| **Install pattern** | `install.py` | **Reuse as pattern.** Pinned wheels per Python version (cp311/312/313), GPU vs CPU torch, CUDA runtime pins. VerseSync's sidecar install follows the same shape. |

Current pinned versions worth noting: `faster-whisper==1.2.1`, `ctranslate2==4.6.2`,
`torch 2.9.0+cu128`, `numpy==2.3.4`, `PySide6==6.9.2`, Python 3.11–3.13, Windows wheels only.

### 2.2 The gaps — this is where the work is

> **Gap 1 — all timing information is discarded.** *(blocking)*

`core/transcription/service.py` `_TranscriptionRunnable.run()`:

```python
segments, _ = self.model.transcribe(str(self.audio_file), language=None, task=self.task_mode)
text_parts = []
for segment in segments:
    text_parts.append(segment.text)          # <- start/end thrown away
text = "\n".join(text_parts)
```

Only `segment.text` is kept. VerseSync's entire premise is timestamps, and segment-level
timing (typically 5–30 s chunks) is far too coarse for a ±0.5 s anchor target.

**Required:** call `transcribe(..., word_timestamps=True)` and retain `segment.words`, each a
`Word(start, end, word, probability)`. The word probability additionally feeds the confidence
score in [04](04-reference-detection.md) §6.

> **Gap 2 — no headless entry point.** *(blocking)*

`main.py` builds a `QApplication` and shows a window; `transcribe.ps1` is two lines that
activate the venv and run it. `TranscriptionService` is a `QObject` emitting Qt signals, and
`_TranscriptionRunnable` is a `QRunnable` on the global `QThreadPool`. There is no way to get a
transcript without a Qt event loop and a GUI.

**Required:** extract a pure function — no Qt, no signals —

```python
def transcribe_with_words(model, audio_path, *, batch_size=None,
                          vad_filter=True, initial_prompt=None,
                          progress=None) -> Transcript
```

into `core/transcription/engine.py`, and have **both** the existing `TranscriptionService` and
the new sidecar call it. The GUI keeps working; the sidecar gains a dependency-light path.
This is a refactor, not a rewrite, and it is the cleanest possible change to the upstream repo.

> **Gap 3 — decoder is not biased toward scripture vocabulary.** *(quality)*

`transcribe()` is called with `language=None` and no `initial_prompt`. Whisper mishears
proper nouns it has no reason to expect — "Philippians"/"Philippines",
"Habakkuk"/"have a cook", "Titus"/"tight us", "Colossians"/"collations".

**Required:** pass an `initial_prompt` seeded with book names and reference phrasing. See
[04](04-reference-detection.md) §2 for the exact prompt and the measurement plan.

> **Gap 4 — no VAD, and `language=None` on every call.** *(quality)*

Sermon audio has long pauses, music beds and applause. Without `vad_filter=True`, Whisper is
prone to hallucinating text in silence, which both creates false detections and can drag
timestamps. Leaving `language=None` re-detects language per run and occasionally misfires on a
musical intro.

**Required:** `vad_filter=True` with tuned `vad_parameters`, and `language="en"` pinned for
VerseSync jobs (configurable).

> **Gap 5 — the default model is the wrong one for this job.** *(quality)*

`config.yaml` ships `model_name: distil-whisper-large-v3`. Distil models have a reduced decoder
and their cross-attention alignment — which is what produces word timestamps — is not the same
as the full models'. Timestamp quality must be measured before trusting it.

**Required:** default VerseSync jobs to `large-v3-turbo` (or `large-v3`), keep distil available
as opt-in, and add a `word_timestamp_quality` field to `ModelMetadata` so the panel can warn
when a model is a poor fit. Spike **T-02** measures this against hand-labelled audio.

> **Gap 6 — no long-audio handling strategy.** *(performance)*

The app is built around short dictation clips. A 45-minute sermon is a different workload:
memory, progress reporting, and cancellation all matter.

**Required:** use `BatchedInferencePipeline` (already wired via the `batch_size` parameter that
`transcribe_file` accepts and `controller.transcribe_file` passes through), stream progress by
segment end-time against total duration, and support cancellation mid-run.

> **Gap 7 — duplicated transcription service.** *(hygiene)*

`core/service.py` and `core/transcription/service.py` are near-identical; the latter adds the
`batch_size` parameter and is the one actually imported by `core/controller.py`.
`core/service.py` is dead code.

**Required:** delete `core/service.py` as part of the Gap-2 refactor, so there is one code path
to keep correct.

> **Gap 8 — `curate_text` would corrupt word alignment.** *(correctness)*

`core/text/curation.py` runs NLTK `sent_tokenize` and rejoins with spaces, and
`_on_transcription_done` additionally strips leading whitespace per line. Both rewrite the text
after the fact, so the string no longer corresponds one-to-one with the word list.

**Required:** curation is **off** for VerseSync jobs. The pipeline consumes the word array, and
any display text is reconstructed from it.

### 2.3 Summary of upstream changes

Changes VerseSync needs in `Faster-Whisper-Transcriber`, all of them additive or clean-up:

1. New `core/transcription/engine.py` with a Qt-free `transcribe_with_words()`.
2. `TranscriptionService` refactored to call it (GUI behaviour unchanged).
3. `core/service.py` deleted.
4. `ModelMetadata` gains `word_timestamp_quality`.
5. Transcribe options extended: `word_timestamps`, `vad_filter`, `vad_parameters`,
   `initial_prompt`, `language`, and a progress callback.

Everything else VerseSync needs lives in the sidecar in this repo, so upstream stays a
dictation tool that happens to expose a good engine.

---

## Part 3 — The gap neither project fills

Nothing in either repository does any of the following. This is VerseSync's actual product,
and where the build effort concentrates:

| Capability | Spec |
|-----------|------|
| Turning transcript words into canonical scripture references | [04-reference-detection.md](04-reference-detection.md) |
| Distinguishing reading from paraphrase | [05-timing-and-placement.md](05-timing-and-placement.md) §4 |
| Computing an anchor and mapping source time to sequence time | [05-timing-and-placement.md](05-timing-and-placement.md) §3, §5 |
| Fetching and formatting verse text | [06-bible-text-service.md](06-bible-text-service.md) |
| The sidecar and its contract | [07-sidecar-api.md](07-sidecar-api.md) |
| Absolute-time insertion and sequence introspection | [08-premiere-host-api.md](08-premiere-host-api.md) |
| The review list | [09-ui-spec.md](09-ui-spec.md) |
