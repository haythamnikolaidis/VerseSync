# 15 — Graphic text layout (wrapping and splitting)

> **Status:** Specified 2026-11-02, not built. Decision **D28**, task **[T-54](tasks/T-54-graphic-text-layout.md)**.

VerseSync writes a cue's whole body into the template's text field as one line, so the text runs
off the screen. VerseFlow solved half of this with a *Max chars / line* setting (upstream commit
`e586b3d`, 2026-09-17), which is newer than the copy in `reference/verseflow/` (`aa7b915`) and was
never carried over. The editor's other habit, splitting a long passage across several graphics,
has never been built in either tool.

Layout applies to **every** cue, whether its text came from the export, the API or a hand edit.

---

## 1. What real graphics look like

Measured on the 33 scripture graphics an editor placed by hand in the spike sermon
(`spikes/word_timestamps/labels.meta.json`, template `AV_Quote_04`):

| Measure | Value |
|---|---|
| Longest line | 87 characters |
| Most lines on a graphic | 4 |
| Most characters on a graphic | 292 |
| Multi-verse passages kept on one graphic | Numbers 6:24-26, Daniel 3:17-18, Acts 16:25-26, Isaiah 60:1-2 |
| Multi-verse passages split | 2 Corinthians 4:6-9: verse 6, verse 7, verses 8-9 |

So the editor splits **when a passage doesn't fit**, not one graphic per verse, and breaks between
verses. Every part keeps the full reference, `2 Corinthians 4:6-9 (NKJV)`.

The rule in §3, at 80 characters and 4 lines, leaves none of the 33 graphics over the limit. It
gives 2 Corinthians 4:6-9 two graphics (verses 6-7 and 8-9) where the editor used three, so it can
differ from an editor's choice while still fitting the screen.

## 2. Settings

On Setup, persisted with the other settings:

| Control | Default | Range | Meaning |
|---|---|---|---|
| **Auto-wrap scripture text** | on | | Off means the body goes in unchanged, as one graphic. |
| **Max chars / line** | `80` | 20–120 | VerseFlow's control, same range. Its default is 45. |
| **Max lines / graphic** | `4` | 1–12 | New. A cue that needs more lines is split. |

Hint under the controls: *Adjust to fit your template's text box.* The two defaults come from §1
and are confirmed on real Premiere in T-54.H.

These are **insert-time** settings. They aren't in the Cue Document, they don't gate Analyse, and
changing them needs no re-analysis. The stored `body` is never altered (FR-4.2).

## 3. The rule

`panel/js/layout.js`, pure functions with no DOM or host dependency.

**Wrap.** `wrapText(text, maxChars)` is a port of VerseFlow's `_wrapText`: split on whitespace, add
words to the line while it stays within `maxChars`, and join the lines with `\n`. A single word
longer than `maxChars` gets its own line. `maxChars` ≤ 0 returns the text unchanged.

**Find the verses.** `verseChunks(body, reference)` walks the body's words looking for the expected
verse numbers in order, `verse`, `verse + 1`, … `verse_end`, as whole tokens. Each number starts a
chunk. Text before the first number belongs to the first chunk, because some translations and
hand-made slides leave the first number off. Looking only for the *next* expected number means
"seven 7" can't start a chunk unless 7 really is next. A chapter-less or single-verse reference
gives one chunk.

**Split.** `layoutCue(cue, settings)` goes through the chunks in order, adding each to the current
graphic while the wrapped result stays within `maxLines`, otherwise starting a new graphic.

- A **single verse** that alone exceeds `maxLines` is cut at the last line that fits, and carries on
  in the next graphic. Text never goes off the screen.
- If it all fits, the result is one graphic with the cue's own id and time, identical to today apart
  from the line breaks.
- Wrap off returns the body unchanged as one graphic.

## 4. Timing the parts

The parts share the cue's placed time and duration, and sit back to back with no gap, as the
editor's do. Part 1 starts at the cue's start, each part ends where the next begins, and the last
part ends at the cue's end. Tick values are frame-snapped and the durations **add up exactly** to
the cue's duration.

A later part's start comes from, in order:

1. **`verse_offsets_s`** ([14 §5](14-scripture-file-import.md)), for a part that begins on a verse
   with a recorded time: the cue's start plus that offset. Offsets are relative to the anchor, so a
   nudge moves the parts with the cue. Used only if the starts stay increasing and inside the cue.
2. **Word share** otherwise: the cue's duration divided by each part's share of the words.

Real timing is the default wherever it exists because reading pace isn't even. On 2 Corinthians
4:6-9 the editor's parts ran 27.2, 6.4 and 23.6 seconds; word share would give about 24.7, 15.0 and
17.6, starting the third part about 6 seconds late. API-sourced cues have no recorded offsets in
this version, so they use word share.

**A part under `min_visible_s` (2.0 s)** still inserts, but its row warns (§5).

## 5. Panel

- **Review row:** a cue that will split shows *Inserts as N graphics*; its expanded row shows the
  parts as they'll appear, with line breaks and each part's start time. A short part adds an amber
  *Part under 2 s*. Changing a setting updates these.
- **One cue, one row.** A split cue is one row and is enabled, edited and nudged as a whole.
- **Insert:** `buildPayload` expands each enabled cue into its parts. A later part's id is
  `<cue id>#<n>`; the first keeps the cue's id, so an unsplit cue's payload differs only in its line
  breaks. Results and the summary are per **graphic** and name the cue.
- **Host:** `VS.insertCues` is unchanged. It already computes `fontTextRunLength` from the text it's
  given, so a body with `\n` needs nothing new. VerseFlow wrapped inside its host; wrapping in the
  panel keeps this in one tested place and leaves the frozen host contract alone.
- **Undo:** D25 still applies, one Ctrl+Z per graphic.

## 6. Testing

- **Unit:** `wrapText` against VerseFlow's output; `verseChunks` with a missing first number, a
  number inside the text and an out-of-range reference; `layoutCue` for a fit, a split, an oversized
  single verse and wrap off.
- **Fixture:** the 33 real line and character measurements, without the licensed text. No part may
  exceed the limits.
- **Timing:** durations add up exactly in ticks; offsets are used when valid and word share when
  they aren't; a nudged cue moves its parts.
- **Human (T-54.H):** on real Premiere, every graphic in the 2026-10-25 sermon stays on screen at
  the defaults, and the line breaks render as line breaks.
