# 03 — Architecture

## 1. The big picture

VerseSync spans three processes. Two of them already exist in some form; the middle one is new.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Adobe Premiere Pro 2026 (Windows)                                            │
│                                                                              │
│   ┌────────────────────────────────┐         ┌────────────────────────────┐  │
│   │  VerseSync panel (Chromium)     │  eval   │  ExtendScript host (.jsx)  │  │
│   │  ── HTML / CSS / JS ──          │ Script  │                            │  │
│   │                                │ ──────► │  VS.getSequenceInfo        │  │
│   │  • setup controls               │         │  VS.getMediaSegments       │  │
│   │  • job progress                 │ ◄────── │  VS.getMogrtFields         │  │
│   │  • REVIEW LIST                  │  JSON   │  VS.insertCues             │  │
│   │  • cue editing                  │         │  VS.setPlayhead            │  │
│   │  • insert orchestration         │         │                            │  │
│   └──────────────┬─────────────────┘         └────────────────────────────┘  │
└──────────────────┼───────────────────────────────────────────────────────────┘
                   │  HTTP + SSE over 127.0.0.1 (bearer token)
                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  VerseSync sidecar — Python, separate process, launched by the panel          │
│                                                                              │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐   │
│   │ Transcriber  │─►│  Detector    │─►│  Resolver    │─►│  Timer         │   │
│   │              │  │              │  │              │  │                │   │
│   │ faster-      │  │ transcript   │  │ reference    │  │ anchors,       │   │
│   │ whisper,     │  │ → refs with  │  │ → verse text │  │ read spans,    │   │
│   │ word stamps  │  │ token spans  │  │ (Bible API)  │  │ durations      │   │
│   └──────┬───────┘  └──────────────┘  └──────┬───────┘  └───────┬────────┘   │
│          │                                   │                  │            │
│   ┌──────▼──────────────────────────┐  ┌─────▼──────┐           ▼            │
│   │ transcript cache (content hash) │  │ verse cache│      Cue Document      │
│   └─────────────────────────────────┘  └────────────┘                        │
└──────────────────────────────────────────────────────────────────────────────┘
                   │
                   ▼  HTTPS (references only — never audio or transcript)
            ┌──────────────┐
            │ Bible API    │
            └──────────────┘
```

## 2. Why this shape

**Why a separate process at all.** Faster-Whisper needs Python, CTranslate2 and a CUDA
runtime. A CEP panel is Chromium plus ExtendScript. There is no way to load one into the
other, so the boundary is forced. Given that, the only real choice was *how* they talk —
decided as HTTP on loopback (D2) because it survives panel reloads, gives free progress
streaming, is trivially testable with `curl`, and keeps the sidecar usable headless.

**Why the sidecar owns detection, resolution and timing.** All three are pure computation over
data structures. Putting them in Python means they are unit-testable without Premiere
installed, they run identically from a CLI, and the panel stays a thin view over a Cue
Document. It also means VerseSync's actual intellectual property is insulated from the
ExtendScript end-of-support clock (inherited risk R-3) — if the Premiere side must be rebuilt
in UXP, none of this moves.

**Why the panel — not the sidecar — owns the source→sequence mapping.** Only Premiere knows
where a media file sits in the current edit. The sidecar computes anchors in **source time**;
the panel converts them to **sequence time** using `VS.getMediaSegments`. This split is what
makes Journey B (re-run after a recut) cheap: the sidecar's output is unchanged, only the
mapping is recomputed.

**Why the host layer is one file.** VerseFlow discovered that `#include` path resolution is
unreliable in Premiere 2026 and consolidated to a single `.jsx`. VerseSync keeps that.

## 3. Process lifecycle

The panel owns the sidecar's lifetime.

1. **Panel opens.** It reads the lock file at `%APPDATA%\VerseSync\sidecar.json`. If present
   and `GET /health` succeeds with the recorded token, it attaches to the running sidecar.
2. **Otherwise it launches one:** `pythonw.exe -m versesync.sidecar` from the configured venv,
   detached, with `--port 0`. The sidecar binds an ephemeral loopback port, writes
   `{pid, port, token, version, started_at}` to the lock file with user-only permissions, then
   serves.
3. **Panel polls `/health`** for up to 30 s (model load can be slow on a cold start), showing
   *Starting transcription service…*.
4. **The sidecar outlives the panel.** Closing the panel does not kill it — reopening
   reattaches, and an in-flight job survives a panel reload. The sidecar self-exits after a
   configurable idle period (default 30 min) with no jobs and no clients.
5. **Version check.** If the sidecar's reported version is incompatible with the panel's, the
   panel offers to stop and relaunch it rather than failing obscurely.

Failure handling: if the sidecar cannot be launched or does not become healthy, the panel says
so plainly, shows the sidecar's log path, and disables **Analyse**. Everything else in the
panel — including loading a saved Cue Document and inserting from it — keeps working, so a
broken sidecar never blocks a review-and-insert pass.

## 4. Data flow

### Journey A — analyse

1. Panel calls `VS.getSequenceInfo` → sequence name, timebase (ticks/frame), frame rate,
   zero point, video track count, playhead.
2. Editor picks media, MOGRT, translation. Panel calls `VS.getMogrtFields` (scratch-insert
   discovery, inherited from VerseFlow) → fields with index, name, group.
3. Panel `POST /jobs` with the media path, translation, and detection options.
4. Sidecar hashes the media file. On a cache hit it skips to step 6.
5. **Transcribe** → a word array with `(text, start, end, probability)` per word.
6. **Detect** → candidate references with canonical form, token span, confidence
   ([04](04-reference-detection.md)).
7. **Resolve** → verse text per reference from the Bible provider, cached
   ([06](06-bible-text-service.md)).
8. **Time** → read-span alignment, classification, anchor in **source time**, duration
   ([05](05-timing-and-placement.md)).
9. Sidecar emits progress over SSE throughout; panel renders the phase and percentage.
10. Panel `GET /jobs/{id}/result` → the **Cue Document**.
11. Panel calls `VS.getMediaSegments({mediaPath})` → the media's placements in the current
    sequence.
12. Panel maps every cue's source anchor to **sequence time**, applies frame snapping, resolves
    overlaps, marks cut-from-edit cues, and renders the **review list**.

### Journey B — insert

1. Panel validates: sequence open, both fields mapped and distinct, ≥1 enabled cue, target
   track selected, no enabled cue still flagged blocking.
2. Panel builds the insert payload — for each enabled cue, `{atTicks, durationTicks,
   reference, body}` — sorted by `atTicks`.
3. Panel calls `VS.insertCues` **once**. The host, inside one undo group, loops:
   `importMGT(path, atTicks, trackIndex, 0)` → `getMGTComponent()` → write both fields by index
   → set duration → dispatch a progress event.
4. Host returns a per-cue success/failure summary; the panel reports what landed.

## 5. Repository layout

```
VerseSync/
├── docs/                         # this package
├── panel/                        # the CEP extension (deployed to %APPDATA%\Adobe\CEP\extensions)
│   ├── CSXS/manifest.xml
│   ├── .debug
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── lib/CSInterface.js    # vendored from Adobe, as VerseFlow
│   │   ├── bridge.js             # promisified evalScript  [from VerseFlow]
│   │   ├── sidecar.js            # HTTP + SSE client, lifecycle, token auth
│   │   ├── cues.js               # Cue Document model, edits, validation
│   │   ├── timemap.js            # source time → sequence time, frame snapping, overlaps
│   │   ├── duration.js           # ticks + reading-speed model  [from VerseFlow]
│   │   ├── review.js             # the review list view
│   │   ├── state.js              # app state + persistence  [from VerseFlow, extended]
│   │   └── main.js               # bootstrap and wiring
│   └── jsx/
│       └── VerseSync.jsx         # the whole host, one file, ES3, no #include
├── sidecar/
│   └── versesync/
│       ├── __main__.py           # `python -m versesync.sidecar`
│       ├── server.py             # HTTP + SSE, auth, lock file
│       ├── jobs.py               # job registry, lifecycle, cancellation
│       ├── transcribe.py         # wraps Faster-Whisper-Transcriber's engine
│       ├── detect/
│       │   ├── normalize.py      # token normalisation, spoken-number parsing
│       │   ├── canon.py          # 66-book table, aliases, chapter/verse counts
│       │   ├── grammar.py        # the reference patterns
│       │   ├── fuzzy.py          # book-name fuzzy matching
│       │   └── detector.py       # orchestration + confidence
│       ├── bible/
│       │   ├── base.py           # BibleProvider interface
│       │   ├── api_bible.py      # API.Bible adapter
│       │   ├── esv.py            # ESV API adapter (optional)
│       │   ├── local.py          # local-store adapter (R-1 contingency)
│       │   ├── cache.py
│       │   └── format.py         # VerseFlow-compatible body/reference formatting
│       ├── timing/
│       │   ├── align.py          # read-span alignment
│       │   └── anchor.py         # anchors, durations, classification
│       ├── cues.py               # Cue Document construction + schema version
│       ├── cache.py              # content hashing, transcript cache
│       └── config.py             # YAML config, credential loading
├── cli/
│   └── versesync_cli.py          # headless: media file in, Cue Document out
├── tests/
│   ├── fixtures/                 # transcripts, expected cues, sample Cue Documents
│   └── ...
└── tools/
    └── accuracy_harness.py       # M1/M2/M3 metrics over the corpus
```

## 6. Contracts

Three contracts hold the system together. Each is versioned and specified in its own document.

| Contract | Between | Spec | Versioning |
|----------|---------|------|-----------|
| **Sidecar HTTP API** | panel ↔ sidecar | [07-sidecar-api.md](07-sidecar-api.md) | `/health` reports `api_version`; the panel refuses a major mismatch. |
| **Cue Document** | sidecar → panel, and on disk | [07-sidecar-api.md](07-sidecar-api.md) §5 | `schema_version` field; the panel migrates or refuses. |
| **`VS.*` host API** | panel ↔ ExtendScript | [08-premiere-host-api.md](08-premiere-host-api.md) | `VS.ping` reports a version; panel warns on mismatch. |

Conventions inherited from VerseFlow and enforced across the host layer:

1. Every host function returns a **JSON string**, either `{"ok":true,"data":…}` or
   `{"ok":false,"error":"message"}`. The host never throws across the bridge.
2. Arguments are passed as a **JSON string** and parsed inside the host, to avoid quoting bugs.
3. Everything is namespaced under a single global `VS`.
4. Helpers use `var fn = function(){}`, never `function fn(){}` — `$.evalFile()` does not hoist
   declarations into persistent global scope in this engine.

## 7. Where each concern lives

A concern lives in exactly one place. When in doubt, this table decides.

| Concern | Owner | Never in |
|---------|-------|----------|
| Audio → words + timestamps | sidecar `transcribe.py` | panel, host |
| Words → references | sidecar `detect/` | panel, host |
| Reference → verse text | sidecar `bible/` | panel, host |
| Read/paraphrase, source-time anchor, duration | sidecar `timing/` | panel, host |
| Source time → sequence time | panel `timemap.js` (data from host) | sidecar |
| Frame snapping | panel `timemap.js` | sidecar |
| Overlap resolution | panel `timemap.js` | sidecar |
| Cue edits, enable/disable, manual adds | panel `cues.js` | sidecar, host |
| Anything touching the Premiere DOM | host `VerseSync.jsx` | panel, sidecar |
| API credentials | sidecar `config.py` | panel, host, Cue Document, logs |

The sidecar deliberately knows nothing about Premiere: it never sees a sequence, a tick, or a
frame rate. It emits seconds in source time. Everything Premiere-shaped happens on the panel
side of the wire, which is what keeps the sidecar independently testable and what makes the
re-run path (Journey B) a pure recomputation.

## 8. Failure model

| Failure | Detected by | Behaviour |
|---------|-------------|-----------|
| Sidecar not installed / won't launch | panel, at open | Clear message + log path; **Analyse** disabled; load-and-insert still works |
| Sidecar dies mid-job | SSE stream closes | Panel reconnects, re-polls `/jobs/{id}`; if gone, offers to restart the job |
| Model fails to load (VRAM, missing CUDA) | sidecar | Job fails with a typed error; panel suggests a smaller model or CPU |
| Media file unreadable / not audio | sidecar | Job fails before transcription; nothing cached |
| Bible API unreachable / rate-limited | sidecar resolver | Job **succeeds**; affected cues flagged `text_unavailable`, excluded from insert by default (FR-4.5) |
| No sequence open | host | **Analyse** and **Insert** both disabled with an explanation |
| Media not present in the sequence | `VS.getMediaSegments` returns empty | Panel warns, offers manual offset entry as a fallback |
| MOGRT has no editable fields | host discovery | Warning per FR-1.4; **Insert** disabled |
| A single `importMGT` fails mid-batch | host | Recorded, batch continues, summary reports it; the undo group still covers everything that did land |

The invariant behind all of it: **nothing reaches the timeline that the editor has not seen in
the review list**, and anything that does reach it is removable with one Ctrl+Z.
