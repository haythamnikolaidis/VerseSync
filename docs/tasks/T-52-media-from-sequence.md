# T-52 · Pick the media from the sequence's audio

| | |
|---|---|
| **Workstream** | F — Panel |
| **Unblocks** | — |
| **Spec** | [09 §3](../09-ui-spec.md) (Media row) · [08 §4](../08-premiere-host-api.md) (`VS.getMediaSegments`) |

## Goal

Replace the free file picker for **Media** with a dropdown of the audio sources actually used in
the open sequence, so the editor can't pick a file that isn't in the edit. Raised in T-30.H
step 30 (2026-10-31): picking media that isn't in the sequence transcribed it first and only
then said *isn't in this sequence*.

## Context

`VS.getMediaSegments` already walks every track item and matches `projectItem.getMediaPath()`
(T-24). Listing the distinct audio sources is the same walk, grouped by path instead of filtered
by it. The 2026-10-25 sermon sequence has seven WAVs (house left/right, pastor lapel, two
handhelds, keys, stream mix). The pastor lapel is the one to transcribe, and the panel can't
know that by itself, so the list has to be easy to read.

Known limits, carried over from T-04: media inside a **nested sequence** or a **multicam
source** doesn't appear in the walk. **Browse…** stays as a fallback for those, keeping today's
manual-offset path (05 §5.4).

## Subtasks

### T-52.1 · Host: `VS.listSequenceMedia`

**Executor** agent · **Size** S · **Prereqs** T-24 · **Status** todo

- **Read:** [08 §4](../08-premiere-host-api.md) · `panel/jsx/VerseSync.jsx` (`getMediaSegments`)
- **Touches:** `panel/jsx/VerseSync.jsx` · `docs/08-premiere-host-api.md` ·
  `tests/host/list-sequence-media.test.js` (new) · `panel/js/host-stub.js` and its fixtures
- **Steps:**
  1. `VS.listSequenceMedia({sequenceId})` → `{ media: [{ mediaPath, name, audioTracks: [int],
     clipCount, sequenceSeconds }] }`, audio tracks only, one entry per distinct media path,
     sorted by `sequenceSeconds`, longest first. Same `sequenceId` check as T-25.1 (D20). Clips
     with no resolvable path are counted in `unresolved`, as `getMediaSegments` does. Tests on
     the fake DOM: several sources across tracks, the same source on two tracks, an unresolvable
     clip, a wrong `sequenceId`. Add it to the host stub. Bump the host API minor version. Commit.
- **Verify:** `node --test tests/host/list-sequence-media.test.js`
- **Done when:**
  - [ ] One entry per distinct source, with the tracks it appears on.

### T-52.2 · Panel: the Media dropdown

**Executor** agent · **Size** S · **Prereqs** T-52.1, T-27.1 · **Status** todo

- **Read:** [09 §3](../09-ui-spec.md)
- **Touches:** `panel/js/setup.js` · `panel/index.html` · `docs/09-ui-spec.md` ·
  `tests/panel/setup-controls.test.js`
- **Steps:**
  1. **Media** becomes a dropdown: `<file name> — A3 · 1:42:10`, refreshed by the sequence
     watcher whenever the sequence changes. The last entry is **Browse…**, which opens today's
     file picker. The choice is still not persisted (FR-1.7). Update 09. Commit.
- **Verify:** `node --test tests/panel/setup-controls.test.js`
- **Done when:**
  - [ ] A file that isn't in the sequence can only come from **Browse…**.
  - [ ] Switching sequences refreshes the list.

### T-52.H · On the real sermon project

**Executor** human · **Size** — · **Prereqs** T-52.2 · **Status** todo

In the 2026-10-25 project, the dropdown lists the seven WAVs with their tracks. Picking the
pastor lapel and analysing gives the same cues as picking it through **Browse…**.

## Traps

- **Audio tracks only.** A video clip's embedded audio is a separate audio track item. Counting
  video items would list every camera file.
- **Don't guess the right source.** List them; the editor chooses.
