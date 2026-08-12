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

**Do not start until T-04 has reported.** That spike establishes what `getMediaPath()` actually
returns for merged clips, multicam clips, nested sequences and speed changes. Implement what it
found, not what seems reasonable.

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
