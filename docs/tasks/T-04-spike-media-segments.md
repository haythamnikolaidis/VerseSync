# T-04 · Spike: source→sequence mapping from a real sequence

| | |
|---|---|
| **Workstream** | S — Spikes |
| **Wave** | 0 |
| **Estimate** | M |
| **Prereqs** | T-01 (including Q-D's answer) |
| **Unblocks** | T-24 |
| **Spec** | [08-premiere-host-api.md §4](../08-premiere-host-api.md) · [05 §5.3](../05-timing-and-placement.md) · risk **R-6** in [12](../12-decisions-and-risks.md) |

## Goal

Confirm `VS.getMediaSegments` is buildable, and characterise exactly which real-world edit
constructs it can and cannot resolve.

## Context you need

Decision D3 says the editor points at a source media file and VerseSync maps source time to
sequence time by walking track items. That mapping is what makes anchors correct across cuts
and trims — and it rests entirely on `clip.projectItem.getMediaPath()` behaving predictably.
**Its behaviour on merged clips, multicam clips and nested sequences is unverified.**

Q-D (from T-01) tells you which of these actually occur in the client's workflow. Test those
first.

## Steps

1. Walk `seq.videoTracks[i].clips[j]` and `seq.audioTracks[i].clips[j]`. For each clip read
   `projectItem.getMediaPath()`, `clip.start`, `clip.end`, `clip.inPoint`, and
   `clip.getSpeed()`.
2. Verify against each construct, recording what `getMediaPath()` actually returns:
   - a straight cut
   - a trimmed clip (non-zero `inPoint`)
   - the same media used **twice** in one sequence
   - a **detached audio** clip (picture from a different camera file)
   - a **speed-changed** clip
   - a **merged** clip
   - a **multicam** clip
   - a **nested** sequence
3. Check path formats: forward vs. back slashes, UNC paths, drive-letter case. This decides the
   normalisation rule in [08 §4](../08-premiere-host-api.md).
4. Time the walk on the longest available sequence — [08 §4](../08-premiere-host-api.md) requires
   one walk, not one per cue.

## Files

- `spikes/media_segments/` — the test `.jsx`, and `RESULTS.md`

## Done when

- [ ] A table of every construct: resolves / does not resolve, and exactly what
      `getMediaPath()` returns.
- [ ] A stated path-normalisation rule.
- [ ] A walk-time measurement on a realistic sequence.
- [ ] Findings fed into [05 §5.3](../05-timing-and-placement.md) and
      [08 §4](../08-premiere-host-api.md) as PRs, so the specs match reality.

## Gate

**T-24 does not start without this.** Anything that does not resolve must be reportable in the
`unsupported` array so the panel can explain itself, rather than silently mis-mapping a cue —
which would place a graphic at a confidently wrong time. That is worse than placing none.

## Traps

- The sermon **audio** may be a detached audio-only clip while the picture comes from a
  different file. A match on either track type is a valid mapping — walk both.
- v1 does not support speed-changed segments (accepted in risk R-6). Confirm you can *detect*
  them reliably; that is the deliverable, not supporting them.
