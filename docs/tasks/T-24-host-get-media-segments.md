# T-24 · Host: `VS.getMediaSegments`

**Executor** agent · **Size** S · **Prereqs** T-23.1 · **Status** todo

| | |
|---|---|
| **Workstream** | G — Host (ExtendScript) |
| **Unblocks** | T-25.H (real data). The panel's time mapping (T-28) is built against the T-39 fixtures, not this. |
| **Spec** | [08-premiere-host-api.md §4](../08-premiere-host-api.md) · [05 §5](../05-timing-and-placement.md) · [`spikes/media_segments/RESULTS.md`](../../spikes/media_segments/RESULTS.md) |

## Goal

Report every placement of a given media file in the target sequence. This is what makes
source-to-sequence mapping possible (FR-5.5). **Reporting nothing is better than reporting
something wrong.**

## T-04 findings to implement exactly

- Straight cuts, trims, duplicates and detached audio all resolve through `getMediaPath()`.
- **`hasProjectItem` true with `mediaPath === ""`** (nested sequence, multicam, or offline
  media) goes to **`unsupported`**. Don't try to tell those cases apart.
- **`speed !== 1.0`** goes to `unsupported` immediately. In and out points are garbage once the
  speed changes.
- **`clip.projectItem === null`**: check `!!clip.projectItem` **first** and skip the clip.
- Merged clips weren't tested. If one is ever seen, it goes to `unsupported`.

## Read

[08 §4](../08-premiere-host-api.md) · the T-04 results table · `tests/fixtures/host/segments-*.json`
(`segments-single` in full, and only the keys of the others)

## Touches

`panel/jsx/VerseSync.jsx` · `tests/host/media-segments.test.js` (new)

## Steps

1. Write `_normalisePath(p)`: change `\` to `/`, collapse repeated slashes (but keep a leading
   `//` for UNC paths), and lowercase. Write `VS.getMediaSegments({mediaPath, sequenceId})`:
   - check the `sequenceId` (D20, T-47);
   - walk **every** video and audio track **once**;
   - for each match, emit a segment with
     `trackType, trackIndex, seqStartTicks, seqEndTicks, inPointTicks, durationTicks, speed,
     name`, using string ticks;
   - send the cases above to `unsupported`, as `{trackType, trackIndex, name, reason}`;
   - return `matched: segments.length > 0`.

   Commit: `T-24 [1/2] getMediaSegments`.
2. Write tests on the fake DOM, one per fixture: `segments-single`, `segments-split`,
   `segments-duplicate`, `segments-speed` and `segments-none`. Build the fake sequence so that
   the expected output **equals the fixture**. Also test a clip with a null `projectItem`, which
   must be skipped without throwing; a nested-style clip, which goes to `unsupported`; path
   normalisation for UNC, backslash and case variants; and a mismatched `sequenceId`, which
   gives the D20 message. Commit: `T-24 [2/2] tests`.

## Verify

`node --test tests/host/media-segments.test.js`

## Done when

- [ ] Every T-39 segments fixture is reproduced exactly from an equivalent fake timeline.
- [ ] Both video and audio tracks are walked, in a single pass.
- [ ] Unresolvable constructs go to `unsupported` with a reason. None are dropped silently.
