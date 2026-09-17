# T-04 — source→sequence mapping spike results

Run on the real client sequence via `spike.jsx`, 2026-09-17. **Names and full client drive
paths are redacted below** (R-12 pastoral privacy, and T-01's "never commit client assets"
rule extends to identifying details captured about them). The unredacted raw log stays local
only — see "Raw log" at the bottom.

Sequence walked: 5 video tracks, 2 audio tracks, 67 track items total.

## Constructs verified

| Construct | Present in real project? | Resolves? | `getMediaPath()` returns | Notes |
|---|---|---|---|---|
| Straight cut | yes (throughout) | yes | real path | |
| Trimmed clip (non-zero inPoint) | yes (throughout — every clip has a distinct inPoint) | yes | real path | inPoint values read correctly |
| Same media used many times | yes — a still image used 8x, a MOGRT cache asset used many times | yes | real path, each occurrence | Each use returns its own segment at its own `seqStart`/`seqEnd` — no special-casing needed, matches §5.2 |
| **Detached audio** (picture ≠ audio file) | **yes, confirmed** — sermon audio is a standalone `.wav`, unrelated in name to any camera file | yes | real path | This is what actually makes source→sequence mapping viable here — see below |
| Speed-changed clip | not present in this project | untested | — | Needs a synthetic test sequence |
| Merged clip | not present in this project | untested | — | Needs a synthetic test sequence |
| **Multicam clip** | yes — 3 cameras + program mix synced via PluralEyes, converted to multicam for editing | **no** | **empty string `""`** | See finding below — collapses into the "nested sequence" case |
| Nested sequence | yes — the multicam edit sits inside a nested sequence on the timeline | **no** | **empty string `""`** | Same failure mode as multicam; no exception thrown, just `""` |

## Headline finding: multicam and nested sequences behave identically, and both fail silently (empty string, not an exception)

The picture side of the edit is not a raw multicam clip sitting directly on V1 — it's a
**nested sequence** wrapping the multicam edit (clip names ending in `"...Nest"`). For every
clip on that track, `projectItem` exists but `getMediaPath()` returns `""`. Same for a second
nested-sequence track (an icon/graphic nest) and for an Adjustment Layer track (no media file
by nature, also `""`).

**This means, functionally, multicam clips *are* nested sequences from `getMediaPath()`'s
point of view** — one code path in `VS.getMediaSegments` handles both. No exception handling
is needed for this case; the walk just needs to treat an empty/falsy `getMediaPath()` result as
non-resolvable and emit it into `unsupported` rather than skipping silently.

A separate track item type was also observed with **no `projectItem` at all**
(`clip.projectItem` itself null) — looks like Premiere 2026's native text/graphic objects,
distinct from MOGRT inserts. These aren't media clips at all and should simply be skipped, not
reported as unsupported.

## Headline finding: the audio track is what makes mapping work at all

Because the picture is unresolvable multicam/nested content, **`VS.getMediaSegments` only
works here because the editor selects the audio file**, not the video. The sermon's actual
audio lives on a standalone `.wav`, fully detached from every camera file — exactly as Q-D
described — and it resolves cleanly with correct per-clip `inPoint`s reflecting real edit cuts.

Two distinct audio files exist in the real sequence: one broken into several cut segments
(tracking the picture edits) and one continuous full-duration clip. **Open item:** confirm with
the editor which one is the primary sermon mic before T-07 defaults are set — the cut one is
the likelier candidate since its segmentation matches the picture edit, but this should not be
assumed silently.

**Implication for the panel's setup UI (T-27):** the instructions/validation for "select your
source media" must steer the editor toward the **audio file**, not the multicam/nested video,
or `VS.getMediaSegments` will always return `matched: false` for what they naturally think of
as "the sermon."

## Path normalisation rule

Confirmed sufficient: replace `\` with `/`, then lowercase the whole string, for comparison.
No UNC paths encountered. Drive letters appear uppercase in raw `getMediaPath()` output
(e.g. `E:\...`) — case-insensitive compare handles this.

## Walk-time measurement

67 clips (5 video tracks + 2 audio tracks) walked in **57 ms**. No performance concern for the
"one walk, not one per cue" requirement, even scaled up considerably.

## Outstanding for full T-04 sign-off

- [ ] Synthetic test sequence for **speed-changed clip** (confirm detection, not support).
- [ ] Synthetic test sequence for **merged clip**.
- [ ] Confirm with editor which of the two audio files is the primary sermon mic.

## Findings to feed back into specs

- [ ] [05-timing-and-placement.md §5.3](../../docs/05-timing-and-placement.md) — update
      "Merged clips and multicam sequences... unverified" to state plainly: multicam and
      nested sequences both return `getMediaPath() === ""` (not an exception), so they can
      share one `unsupported` code path. Add a note that the manual-offset fallback (§5.4) is
      the expected outcome whenever the editor's source is a multicam/nested picture edit
      rather than a flat audio/video file.
- [ ] [08-premiere-host-api.md §4](../../docs/08-premiere-host-api.md) — document the
      confirmed path-normalisation rule (slash-replace + lowercase, no UNC seen) and add
      `""`/falsy `getMediaPath()` results (multicam, nested sequence, adjustment layer) plus
      track items with no `projectItem` at all (native graphic objects) as explicit,
      non-exceptional cases the walk must handle.
- [ ] [09-ui-spec.md](../../docs/09-ui-spec.md) (T-27) — setup UI copy/validation should guide
      the editor to select the **audio** source file, since picture-side multicam/nested
      sequences will not resolve.

## Raw log

Not committed — contains client file paths and names (R-12). Kept locally at
`~/Desktop/verse_sync_media_segments_results.txt` on the dev machine that ran the spike.
