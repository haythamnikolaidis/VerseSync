# 07 — Sidecar API and the Cue Document

The contract between the CEP panel and the Python sidecar. Also the home of the **Cue
Document** schema, which is both this API's payload and the on-disk save format (FR-6.8).

---

## 1. Transport and lifecycle

- **HTTP/1.1 on `127.0.0.1`**, ephemeral port, plus **Server-Sent Events** for progress.
- The sidecar **never** binds a non-loopback interface.
- Started, discovered and version-checked by the panel per [03](03-architecture.md) §3.

### 1.1 Lock file

`%APPDATA%\VerseSync\sidecar.json`, written at startup with user-only ACLs:

```json
{ "pid": 24880, "port": 51733, "token": "b7f3…", "api_version": "1.0",
  "sidecar_version": "1.0.0", "started_at": "2026-08-09T10:14:22Z" }
```

Stale-lock handling: if `/health` fails against the recorded port, or the PID is not alive, the
panel deletes the lock and launches a new sidecar.

### 1.2 Authentication

Every request carries `Authorization: Bearer <token>` from the lock file. The token is
generated per launch from `secrets.token_urlsafe(32)`. A missing or wrong token gets `401`
with no body.

This matters more than it looks: a CEP panel runs a Chromium context, and any page that context
loads could otherwise reach a loopback service. Loopback binding plus a per-launch token plus
an `Origin` allowlist is the minimum bar (NFR-4).

### 1.3 Headers

| Header | Direction | Purpose |
|--------|-----------|---------|
| `Authorization: Bearer …` | request | Required on everything except `/health` |
| `X-VerseSync-Api: 1.0` | response | API version; panel refuses a major mismatch |
| `Origin` | request | Allowlisted to the panel's CEP origin; others rejected |

---

## 2. Endpoints

### `GET /health`

Unauthenticated, cheap, safe to poll.

```json
{ "status": "ready", "api_version": "1.0", "sidecar_version": "1.0.0",
  "device": "cuda", "model_loaded": "large-v3-turbo",
  "gpu": { "name": "NVIDIA RTX 4070", "vram_total_mb": 12282, "vram_free_mb": 9104 },
  "provider": { "id": "api_bible", "reachable": true },
  "active_jobs": 0 }
```

`status` ∈ `starting | ready | busy | degraded`. `degraded` means it will serve but something
is wrong — no GPU, provider unreachable — and the panel surfaces the reason.

### `GET /models`

Available models with the metadata VerseSync adds on top of Faster-Whisper-Transcriber's table
(§2.2 of [02](02-source-project-audit.md)):

```json
{ "models": [
    { "name": "large-v3-turbo", "word_timestamp_quality": "good",
      "supported_quantizations": { "cuda": ["float16","bfloat16","float32"], "cpu": ["float32"] },
      "downloaded": true, "recommended": true },
    { "name": "distil-whisper-large-v3", "word_timestamp_quality": "unverified",
      "downloaded": true, "recommended": false }
] }
```

### `GET /translations`

Translations available for the configured provider and credentials (FR-1.5). Includes the
attribution string and the caching permission from [06](06-bible-text-service.md) §5.

```json
{ "provider": "api_bible",
  "translations": [
    { "id": "de4e12af7f28f599-02", "abbreviation": "KJV", "name": "King James Version",
      "attribution": "Public domain.", "cache_allowed": true }
] }
```

### `POST /jobs`

Start an analysis. Returns immediately.

```json
{
  "media_path": "D:/Sermons/2026-08-09/SERMON_A001.MXF",
  "translation_id": "de4e12af7f28f599-02",
  "options": {
    "model": "large-v3-turbo",
    "device": "cuda",
    "quantization": "float16",
    "batch_size": 8,
    "language": "en",
    "use_cache": true,
    "detection": { "context_window_s": 120, "duplicate_cooldown_s": 60 },
    "timing":    { "read_coverage_threshold": 0.55, "lead_in_s": 0.5, "tail_pad_s": 1.0 }
  }
}
```

→ `202 Accepted`

```json
{ "job_id": "job_01J9…", "status": "queued", "cache_hit": false,
  "estimated_duration_s": 190 }
```

`media_path` must be a file the sidecar can read; it is validated against the session's
allowed roots (NFR-4). `cache_hit: true` means transcription will be skipped and the job will
finish in seconds.

### `GET /jobs/{id}`

```json
{ "job_id": "job_01J9…", "status": "running",
  "phase": "detecting", "progress": 0.72,
  "elapsed_s": 138, "eta_s": 44,
  "message": "Detecting references (14 found)",
  "error": null }
```

`status` ∈ `queued | running | done | failed | cancelled`.
`phase` ∈ `hashing | transcribing | detecting | resolving | timing`.

### `GET /jobs/{id}/events` — SSE

The progress channel. Same payload as above, emitted on every phase change and at most twice a
second within a phase.

```
event: progress
data: {"phase":"transcribing","progress":0.41,"eta_s":112}

event: progress
data: {"phase":"resolving","progress":0.88,"message":"Fetching 1 Corinthians 6:19-20"}

event: done
data: {"job_id":"job_01J9…","cue_count":18}
```

The panel must tolerate the stream dropping — CEP panels reload — and fall back to polling
`GET /jobs/{id}` (NFR-3).

### `GET /jobs/{id}/result`

The **Cue Document** (§5). `409` if the job is not `done`.

### `DELETE /jobs/{id}`

Cancels a running job or discards a finished one. Cancellation is cooperative: the transcriber
checks a flag between segments, so it takes effect within a few seconds rather than instantly.

### `POST /resolve`

Resolve a single reference on demand — what the review list calls when an editor corrects a
reference or adds one by hand (FR-6.3, FR-6.4).

```json
{ "reference": "Romans 8:28", "translation_id": "de4e12af7f28f599-02" }
```

→ a `Passage` ([06](06-bible-text-service.md) §1), or a typed error. Also accepts a canonical
object instead of a string; the string form is parsed with the same canon table detection uses,
so what an editor types is validated the same way.

### `POST /shutdown`

Graceful stop. Used by the panel's version-mismatch path.

---

## 3. Error format

Every non-2xx carries the same body:

```json
{ "error": { "code": "model_load_failed",
             "message": "Could not load large-v3-turbo on cuda: out of memory (9.1 GB free, ~10.4 GB required)",
             "detail": "…", "retryable": true,
             "hint": "Try large-v3-turbo with float16, or switch to CPU." } }
```

`code` is a stable machine-readable string; `message` is shown to the editor as-is, so it is
written for an editor, not a developer. `hint` gives the next action where one exists. Codes:

`bad_request` · `unauthorized` · `media_not_found` · `media_unreadable` ·
`model_load_failed` · `transcription_failed` · `provider_unavailable` ·
`translation_not_licensed` · `job_not_found` · `job_not_finished` · `cancelled` · `internal`

---

## 4. Progress accounting

Phase weights, so a single 0–1 bar behaves sensibly (`transcribing` dominates and is the only
phase with meaningful internal progress):

| Phase | Weight | Internal progress from |
|-------|--------|------------------------|
| `hashing` | 0.02 | bytes read |
| `transcribing` | 0.80 | last segment end ÷ media duration |
| `detecting` | 0.05 | tokens scanned |
| `resolving` | 0.10 | passages fetched (0 on a warm cache) |
| `timing` | 0.03 | cues processed |

On a cache hit, `transcribing` is skipped and the remaining weights are renormalised — which is
why a re-run visibly races through the bar (Journey B).

---

## 5. The Cue Document

The sidecar's output, the panel's input, and the save format. **Versioned.**

```json
{
  "schema_version": "1.0",
  "generated_at": "2026-08-09T10:21:47Z",
  "job": {
    "id": "job_01J9…",
    "media_path": "D:/Sermons/2026-08-09/SERMON_A001.MXF",
    "media_hash": "sha256:9f2c…",
    "media_duration_s": 2714.36,
    "model": "large-v3-turbo",
    "quantization": "float16",
    "device": "cuda",
    "language": "en",
    "options": { "…": "the resolved options actually used" }
  },
  "translation": {
    "id": "de4e12af7f28f599-02", "abbreviation": "KJV", "name": "King James Version",
    "attribution": "Public domain."
  },
  "transcript": {
    "word_count": 7412,
    "words_ref": "transcript_01J9….json"
  },
  "cues": [
    {
      "id": "cue_014",
      "enabled": true,
      "origin": "detected",

      "reference": { "book": "1 Corinthians", "osis": "1Cor",
                     "chapter": 6, "verse": 19, "verse_end": 20 },
      "reference_display": "1 Corinthians 6:19-20 (KJV)",
      "body": "19 What? know ye not that your body is the temple…",
      "body_word_count": 61,
      "body_truncated": false,

      "source_anchor_s": 1425.32,
      "source_duration_s": 27.08,
      "mention_start_s": 1425.82,
      "mention_end_s": 1427.61,

      "classification": "read",
      "read_coverage": 0.78,
      "read_start_s": 1428.90,
      "read_end_s": 1451.40,

      "confidence": 1.0,
      "detection": {
        "pattern": "P6", "contextual": false,
        "book_match": { "tier": "exact", "distance": 0 },
        "token_span": [1841, 1849], "word_span": [2103, 2112]
      },
      "snippet": "…turn with me to First Corinthians six, nineteen and twenty. Or do you not know…",

      "flags": [],
      "alternatives": []
    }
  ],
  "warnings": [
    { "code": "provider_partial", "message": "2 passages could not be fetched." }
  ]
}
```

### 5.1 Field notes

- **All times in the Cue Document are `source` seconds.** The sidecar has no idea what a
  sequence is. Sequence ticks are computed in the panel and are *not* persisted here — a saved
  Cue Document therefore stays valid across a recut, which is the point.
- **`origin`** ∈ `detected | manual | edited`. Manual cues (FR-6.4) have no `detection` block,
  a `confidence` of `1.0`, and their anchor supplied by the editor.
- **`flags`** is the review list's colour source. Defined values:
  `low_confidence` · `overlap` · `truncated` · `long_passage` · `text_unavailable` ·
  `passage_not_found` · `chapter_only` · `suppressed_duplicate` · `cut_from_edit` ·
  `multiple_placements` · `speed_change_unsupported`.
  The last three are added by the **panel** after mapping, not by the sidecar.
- **`alternatives`** holds competing readings from detection — the Psalms
  concatenation ambiguity ([04](04-reference-detection.md) §3.1) and multi-placement options
  ([05](05-timing-and-placement.md) §5.2) — so the review row can offer a one-click switch.
- **`transcript.words_ref`** points at a sibling file rather than inlining ~7,000 word objects.
  The panel fetches it only when an editor expands a row for context.

### 5.2 Versioning

`schema_version` is `major.minor`. The panel accepts any matching major and warns on a newer
minor. A major mismatch is refused with an explanation rather than a parse error — a Cue
Document saved months ago should fail clearly, not silently place graphics wrongly.

---

## 6. CLI parity

`cli/versesync_cli.py` exposes the same pipeline with no HTTP and no Premiere:

```
python -m versesync.cli analyse D:/Sermons/sermon.mxf --translation kjv --out cues.json
python -m versesync.cli detect  transcript.json --out detections.json
python -m versesync.cli resolve "Romans 8:28" --translation kjv
```

This is not a convenience — it is how detection and timing get developed and tested at all
(NFR-5), how the accuracy harness runs ([11](11-testing.md) §4), and how a support issue gets
reproduced without an editing workstation. It must stay in step with the service; both call the
same pipeline functions, and a test asserts identical output for the same input.
