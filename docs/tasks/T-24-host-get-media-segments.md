# T-24 · Host: `VS.getMediaSegments`

| | |
|---|---|
| **Workstream** | G — Host (ExtendScript) |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | **T-04 (hard gate)**, T-23 |
| **Unblocks** | T-28 (real data — T-28 itself builds against T-39 fixtures) |
| **Spec** | [08-premiere-host-api.md §4](../08-premiere-host-api.md) · [05 §5](../05-timing-and-placement.md) |

## Goal

Report every placement of a given media file in the active sequence. **New in VerseSync —
nothing like it exists in VerseFlow.** This is what makes source→sequence mapping possible
(FR-5.5).

## Context you need

✅ **T-04 has reported** — see
[`spikes/media_segments/RESULTS.md`](../../spikes/media_segments/RESULTS.md).
Key findings to implement exactly, not what seems reasonable:

- **Straight cuts, trims, duplicate media, detached audio** all resolve cleanly via
  `getMediaPath()` — no surprises.
- **Nested sequences and multicam clips produce an identical signature**:
  `hasProjectItem: true`, `mediaPath: ""` (empty, no error thrown),
  `projectItemType: 1`, and the `getSequence`-based heuristic tried in the
  spike does **not** distinguish them. There is no reliable positive signal
  to tell nested/multicam/offline-media apart from each other — **don't try.
  Treat any clip with `hasProjectItem: true` and `mediaPath === ""` as
  unresolvable and route it to `unsupported`**, regardless of which of the
  three it actually is.
- **Speed-changed clips**: `clip.getSpeed()` reliably reports the real
  multiplier (confirmed `1.1` on a real clip), but `inPointTicks`/
  `outPointTicks` are **not usable** as source time once speed ≠ 1.0 (they
  resolved to a value corresponding to ~30 days into the source on the test
  clip) — detect via `speed !== 1.0` and route to `unsupported`
  immediately; do not attempt to use the in/out values for anything.
- **Some real track items have `clip.projectItem === null`** (confirmed on
  pre-existing "Graphic" clips in the client's actual edit, unrelated to any
  Premiere/VerseFlow-specific construct) — chaining `.getMediaPath()` off a
  null `projectItem` throws. **Check `!!clip.projectItem` first and skip
  immediately** if false, before touching any other `projectItem` field.
- **Merged clips were not tested** — confirmed with the editor this
  construct isn't used in the client's real workflow. Not a blocker; if one
  is ever encountered, route it to `unsupported` like any other unresolved
  case rather than assuming it works.
- **Walk time**: 85ms for 105 clips on the real test sequence — no
  performance concern for a one-time pre-insert walk.

⚠️ **Separate, cross-cutting risk surfaced during T-04 (not about media
mapping itself):** `app.project.activeSequence` does not reliably track
which sequence has UI focus, and a script-side assignment to it does not
persist across separate `evalScript` calls. Since the panel calls
`VS.getMediaSegments` and `VS.insertCues` ([T-25](T-25-host-insert-cues.md))
as separate round-trips with editor interaction in between, the editor
switching sequence tabs in that window could cause `VS.insertCues` to
silently target the wrong sequence. This needs a decision — re-verify the
target sequence's identity immediately before inserting and abort if it
changed, at minimum — tracked in
[12-decisions-and-risks.md](../12-decisions-and-risks.md).

The failure mode this guards against: silently mis-mapping a cue puts a graphic at a
confidently wrong time. **Reporting nothing is better than reporting something wrong** — the
panel has a manual-offset fallback ([05 §5.4](../05-timing-and-placement.md)) but no defence
against bad data.

## Steps

1. Walk `seq.videoTracks[i].clips[j]` **and** `seq.audioTracks[i].clips[j]`. The sermon's audio
   may be a detached audio-only clip while the picture comes from a different camera file — a
   match on either track type is a valid mapping.
2. For each clip, compare `clip.projectItem.getMediaPath()` to the target using the
   **normalisation rule T-04 established**: forward/back slashes, UNC paths, Windows
   case-insensitivity. Compare normalised lowercase strings.
3. Emit per matching segment: `trackType`, `trackIndex`, `seqStartTicks`, `seqEndTicks`,
   `inPointTicks`, `durationTicks`, `speed`, `name` — all ticks as **strings**.
4. Any segment with `speed !== 1.0` goes into **`unsupported`** with a reason. v1 does not
   support speed-changed segments (accepted, risk R-6); the panel flags affected cues
   `speed_change_unsupported`.
5. Report anything T-04 found unresolvable (merged, multicam, nested) in `unsupported` with a
   reason, so the panel can explain itself.
6. `matched: false` with an empty `segments` array means the media is not in this sequence at
   all — that triggers the panel's manual-offset fallback.
7. **Walk once.** A long sequence holds thousands of track items; this must never be called per
   cue.

## Files

- `panel/jsx/VerseSync.jsx` (extended)

## Done when

- [ ] Every case from T-04's results table returns the documented result on a real sequence.
- [ ] Both video and audio tracks are walked.
- [ ] Speed-changed segments appear in `unsupported`, not in `segments`.
- [ ] Media absent from the sequence returns `matched: false`.
- [ ] One walk on the longest available sequence completes in acceptable time.
- [ ] Output matches the T-39 fixture shapes exactly, so swapping stub for real is a no-op.

## Traps

- Ticks as **strings**, always. T-28 was built against T-39 fixtures that do this.
- Trimmed clips have a non-zero `inPoint` — it is essential to the mapping
  (`t_seq = seqStart + (t_src - inPoint)`), not decoration.
- Do not silently drop a construct you cannot resolve. Put it in `unsupported` with a reason.
