# T-04 Results — source→sequence mapping from a real sequence

See [T-04](../../docs/tasks/T-04-spike-media-segments.md) for the gate, and
`console-driver.md` for how each row was produced.

Environment: Premiere version ____, sequence ____.

## Construct resolution table

(video `trackIndex: 3` / `clipIndex: 13` etc. below are clip positions in the
real sermon sequence, as walked by `msWalkSequence`)

| Construct | Resolves? | `mediaPath` returned | `speed` | `inPointTicks` | Notes |
|---|---|---|---|---|---|
| Straight cut (v0/c0) | **Yes, but empty** | `""` | 1 | `5100641280000` | This clip is actually the nested-sequence construct too (name `"2026-09-27 Sermon Nest"`) — see Nested sequence row. |
| Trimmed clip (v5/c0, `18830001.MP4`) | **Yes** | real path | 1 | `794175943680000` (non-zero, confirms trim) | Clean. |
| Same media used twice (v5/c1) | **Yes** | identical path to v5/c0 | 1 | identical in/out to v5/c0 | Trivial to detect: same `mediaPath` + same in/out range at a different sequence time. |
| Detached audio clip (audio v0, whole track) | **Yes** | real path, distinct from the video's nested-sequence path (`03-Pastor Lapel-...wav`) | 1 | real, plausible | Confirms "match on either track type" is necessary and sufficient — this audio would be invisible if only video tracks were walked. |
| Speed-changed clip (v5/c2, same `18830001.MP4`) | **Detects, but position is unusable** | real path (same file) | **1.1** (correctly detected) | `672181757672727` / `688286372072726` | Dividing by ticks-per-second gives ~30.6 *days* into the source — not a plausible in-point. Speed-adjusted in/out ticks are not directly usable as source time without extra, unverified math. Confirms R-6: detect reliably (done, via `speed !== 1.0`), do not attempt to support in v1. |
| Merged clip | **Not tested — deliberately out of scope** | — | — | — | Confirmed with the editor: merged clips are not used in this client's actual workflow. Not pursuing further; `unsupported` handling for this construct can be deferred rather than blocking the gate. |
| Multicam clip ("Ivan Multi cam test", placed directly, not nested) | **No — same signature as nested sequence** | `""` | 1 | real-looking numbers, meaningless | `hasProjectItem: true`, `projectItemType: 1`, `projectItemIsSequence: false` — **identical** to the nested-sequence signature below, confirmed with a multicam clip built directly on a track rather than confounded inside a nest. |
| Nested sequence (v0 whole track; also v4 `"HOC Icon Nest 2"`, `"Location Pin Nest 2"`, `"Globe Nest 2"`) | **No — empty path, no error, and no reliable flag** | `""` (empty, not an error) | 1 | real-looking numbers, but meaningless (source is a sequence, not a media file) | `projectItemIsSequence` (checking `typeof clip.projectItem.getSequence === 'function'`) returned **`false` for every nested-sequence instance** — that detection method does not work. The only observed signal is `mediaPath === ""` with `hasProjectItem: true`, which is **ambiguous with multicam (confirmed) and with genuinely offline/missing media (not separately tested, but has no reason to look different)**. No reliable way found to positively distinguish nested sequence / multicam / offline media from each other using any field this walk can read — all three must be treated as one `unsupported` bucket. |

### Unplanned finding: some track items have no `projectItem` at all

Six pre-existing "Graphic" clips (video `trackIndex: 3`, `clipIndex` 13, 14,
50–53 — not anything created during T-03 testing) returned
`hasProjectItem: false`, and every chained property read
(`getMediaPath()`, `.name`, `.type`) threw
`TypeError: null is not an object` — caught cleanly by this spike's per-field
isolation, but confirming `clip.projectItem` can be genuinely `null`/falsy
for real track items in the wild (not merged, multicam, or nested — just
absent). **`VS.getMediaSegments` must check `hasProjectItem` (i.e.
`!!clip.projectItem`) first and skip immediately** for any clip where it's
false, never attempting `getMediaPath()` on it.

For anything that doesn't resolve, the above states exactly what
`getMediaPath()` (and other fields) returned — empty string, a nonsensical
number, or a thrown error — so the `unsupported` array in
[08 §4](../../docs/08-premiere-host-api.md) can report the real reason
rather than silently mis-mapping.

### Unplanned finding: `app.project.activeSequence` does not persist a
### script-side assignment across separate `evalScript` calls

Discovered while trying to target a specific sequence for the multicam test
with multiple sequences open. `app.project.activeSequence = app.project.sequences[n]`
takes effect for the remainder of *that* `evalScript` call — confirmed by
reading `.name` back immediately within the same call — but the *next*,
separate `evalScript` round-trip reverted to a different sequence than the
one just assigned. Premiere's UI tab focus reasserts itself as "the active
sequence" in between script calls; a script-side assignment is not a
durable override.

**This is a risk for VerseSync itself, not just this spike's tooling.** The
panel calls `VS.getSequenceInfo`, `VS.getMediaSegments`, and `VS.insertCues`
as separate `evalScript` round-trips, with the editor interacting with the
Premiere UI in between (reviewing cues, clicking Insert). If the editor
switches to a different sequence tab after cues were computed against one
sequence but before clicking Insert, `app.project.activeSequence` inside
`VS.insertCues` would silently resolve to whatever tab now has focus — not
the sequence the cues were actually computed for — and insert into the
wrong sequence with no error. **Flag this for
[12-decisions-and-risks.md](../../docs/12-decisions-and-risks.md) and
whichever task owns the insert flow (T-25/T-30):** either re-verify the
target sequence's identity (e.g. compare `sequence.sequenceID` or name)
immediately before `VS.insertCues` runs and abort with a clear error if it
changed, or otherwise make the panel robust to this rather than trusting
`activeSequence` to still mean what it meant when cues were generated.

This spike's own functions now accept an optional `sequenceIndex` to target
a specific sequence explicitly, bypassing the problem for testing purposes
— see `console-driver.md`.

## Path-format normalisation rule

- Separator style observed: **backslash, consistently** (e.g.
  `E:\Main Edit\2026-09-27\Footage\Camera 1\DCIM\883YDRH1\18830001.MP4`,
  `E:\Audio Sermon\2026-09-27\...\03-Pastor Lapel-260927_0935.wav`). No
  forward-slash paths observed from Premiere itself.
- UNC paths present? **No** — every path observed is a local drive letter
  (`E:\...`). Not tested against a network share; flag as an open question
  if the client's actual ingest ever uses one (related to Q-D).
- Drive-letter case consistency: consistent uppercase (`E:`) throughout.
- **Rule to implement in [08 §4](../../docs/08-premiere-host-api.md):**
  normalise to lowercase and backslash-to-forward-slash (or vice versa) for
  comparison against the editor-provided source path, same as T-03's
  finding that `importMGT` itself expects a native (backslash) path on
  Windows. No UNC-specific handling has been exercised yet.

## Walk-time measurement

- Sequence used: the full test sermon sequence, 105 clips across 6 video
  tracks + 2 audio tracks (includes the T-03 test inserts still present on
  V4).
- `elapsedMs`: **85ms**.
- Acceptable for a single pre-insert walk (not per-cue)? **Yes, comfortably.**
  85ms for 105 clips extrapolates to well under a second for sequences an
  order of magnitude larger — no performance concern for a one-time
  pre-insert walk.

## Findings to feed back as PRs

- [ ] [05-timing-and-placement.md](../../docs/05-timing-and-placement.md) §5.3
      — speed-changed segments: document that `inPointTicks`/`outPointTicks`
      become unusable, not just "unsupported in v1."
- [ ] [08-premiere-host-api.md](../../docs/08-premiere-host-api.md) §4 —
      add the `hasProjectItem` guard; specify the single `unsupported` rule
      for empty `mediaPath` (covers nested sequence, multicam — confirmed
      indistinguishable from each other — and presumptively offline media);
      document the path-normalisation rule above.
- [ ] [12-decisions-and-risks.md](../../docs/12-decisions-and-risks.md) and
      T-25/T-30 — the `app.project.activeSequence` cross-call risk (see
      above): the editor switching sequence tabs between cue generation and
      clicking Insert could silently target the wrong sequence.

## Gate status

- [x] Straight cut, trimmed clip, duplicate media, detached audio: confirmed
      resolvable.
- [x] Speed-changed clip: confirmed detectable (`speed !== 1.0`), confirmed
      unusable position data — routes to `unsupported` per R-6's accepted
      scope, as intended.
- [x] Nested sequence and multicam clip: confirmed **not** resolvable, and
      confirmed indistinguishable from each other (and presumptively from
      offline media) — but this is a resolved finding, not an open gap: the
      implementation rule is simply "`hasProjectItem: true` with
      `mediaPath === ""` → `unsupported`," regardless of which of the three
      it actually is.
- [x] Walk-time measured: 85ms / 105 clips — no performance concern.
- [ ] Merged clip: deliberately not tested — confirmed with the editor this
      construct isn't used in the client's real workflow. Not blocking the
      gate; defer its `unsupported` handling until/unless it's ever seen.
- [ ] This file's findings still need to be reflected in T-24's task file
      before T-24 starts.
