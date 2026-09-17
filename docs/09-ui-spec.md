# 09 — UI Specification

The panel. Two modes — **Setup** and **Review** — in one dockable column, because decision D4
makes the review pass the centre of the product, not a dialog on the way to it.

Target panel width **340–600 px** (VerseFlow's manifest geometry), so everything is designed
for a narrow column that grows usefully when widened.

---

## 1. Layout

```
┌────────────────────────────────────────────┐
│ VerseSync                          ● ready │  status strip
├────────────────────────────────────────────┤
│ ▸ SETUP                                    │  collapses after a successful analysis
│   Media file      [ Select… ] SERMON_A001  │
│   Template        [ Select… ] AV_Quote_04  │
│     Reference →   [ Description > Text  ▾] │
│     Scripture →   [ Title Main > Text   ▾] │
│   Translation     [ King James (KJV)    ▾] │
│   Target track    [ V3 ▾ ]      [Refresh]  │
│   Duration        (•) Auto  ( ) Fixed [ ]s │
│   Lead-in         [ 0.5 ] s                │
│                                            │
│        [        Analyse        ]           │
├────────────────────────────────────────────┤
│ Transcribing…  ████████░░░░░░  62%  ~1m04s │  progress (during a job)
│                              [ Cancel ]    │
├────────────────────────────────────────────┤
│ REVIEW — 18 found · 16 enabled     [⚑ 3]   │
│ [✓ All] [✗ None] [Flagged only]  [Save▾]   │
│ ┌────────────────────────────────────────┐ │
│ │☑ 00:07:12:04  Romans 8:28              │ │
│ │  PARAPHRASE · 92% · 6.4s               │ │
│ │  "…Paul reminds us in Romans eight…"   │ │
│ ├────────────────────────────────────────┤ │
│ │☑ 00:23:45:11  1 Corinthians 6:19-20  ⚑ │ │
│ │  READ · 100% · 27.1s     overlap       │ │
│ │  "…turn with me to First Corinthians…" │ │
│ ├────────────────────────────────────────┤ │
│ │☐ 00:31:02:19  Romans 8            ⚑    │ │
│ │  chapter only — no verse text          │ │
│ └────────────────────────────────────────┘ │
│                                            │
│        [   Insert 16 scriptures   ]        │
│ Placed 16 of 16.                           │
└────────────────────────────────────────────┘
```

---

## 2. Status strip

Always visible, one line, the first thing an editor looks at when something is wrong.

| State | Shows | Insert/Analyse |
|-------|-------|----------------|
| Sidecar starting | `◌ starting transcription service…` | Analyse disabled |
| Ready, sequence open | `● ready · cuda · large-v3-turbo` | both enabled per validation |
| No sequence | `▲ no sequence open` | both disabled |
| Sidecar unreachable | `✕ transcription service unavailable` + **Details** | Analyse disabled; **Insert still works** from a loaded Cue Document |
| Degraded | `▲ ready (CPU only)` or `▲ ready (Bible API unreachable)` | enabled, with the caveat visible |

The sidecar-down case explicitly keeps the insert path alive (FR-6.8, [03](03-architecture.md)
§8). An editor who already has a reviewed Cue Document should never be blocked by a Python
process.

---

## 3. Setup

Field-by-field behaviour. Everything except the media file persists between sessions (FR-1.7),
so a weekly run is: pick media, click Analyse.

| Control | Behaviour |
|---------|-----------|
| **Media file** | `window.cep.fs.showOpenDialog` filtered to audio/video extensions — **not** ExtendScript `File.openDialog`, which fails in Premiere 2026 (VerseFlow's finding). Shows basename, full path on hover. **Helper text below the field says to select the sermon audio file, not a multicam or nested-sequence picture edit** — spike T-04 confirmed the latter never resolves via `VS.getMediaSegments` ([05](05-timing-and-placement.md) §5.3), which is the common case, not an edge case, for multicam-based workflows. |
| **Template** | `.mogrt` picker. On selection, calls `VS.getMogrtFields` with a *Reading template…* busy state. Zero fields → the VerseFlow warning about After Effects–authored templates (FR-1.4). |
| **Reference / Scripture dropdowns** | Populated with group-qualified labels (`Description > Text`), values are field **indices**. VerseFlow's smart defaults apply: reference ← group matching `/descr\|caption\|sub\|credit\|author/i`, body ← `/title\|main\|quote\|body/i`. Same field for both is a validation error. Persisted per MOGRT path. |
| **Translation** | From `GET /translations`. Shows the licence attribution beneath it in small type (FR-4.7). Disabled while the sidecar is unreachable. |
| **Target track** | From `VS.getSequenceInfo`, listed V-high to V-low, defaulting to topmost. **Refresh** re-reads. |
| **Duration** | Auto (per-cue, from classification) or Fixed. Auto is the default and the point of the product. |
| **Lead-in** | Seconds, default 0.5, range 0–3. The one timing constant editors will actually want to touch. |

**Analyse** is enabled only when: sidecar ready, sequence open, media selected, template
selected with ≥1 field, both fields mapped and distinct, translation selected, track selected.
When disabled, the reason is shown next to it — not just a greyed button.

---

## 4. Progress

Visible only during a job. One bar driven by the weighted phases in
[07](07-sidecar-api.md) §4, a phase label, an elapsed/ETA readout after 10%, and **Cancel**.

Setup collapses to a one-line summary while a job runs and after it completes, so the review
list gets the panel's height. Clicking the summary reopens it.

A cache hit shows `Using cached transcript` and the bar races to the resolving phase — this is
Journey B and it should visibly feel different from a cold run.

---

## 5. The review list

The core screen. Sorted by sequence timecode.

### 5.1 Collapsed row

```
☑  00:23:45:11   1 Corinthians 6:19-20                    ⚑
   READ · 100% · 27.1s                              overlap
   "…turn with me to First Corinthians six, nineteen and…"
```

- **Checkbox** — enable/disable. Disabled rows dim and drop out of the Insert count.
- **Timecode** — sequence timecode including `zeroPoint`. **Clicking it calls `VS.setPlayhead`**
  so Premiere jumps there (FR-6.6). This one interaction does more for trust than any amount of
  confidence display: the editor hears the moment.
- **Reference** — canonical display form.
- **Badge** — `READ` or `PARAPHRASE`.
- **Confidence** — percentage. Below the threshold (0.55) it is amber.
- **Duration** — resolved seconds.
- **Snippet** — the transcript around the mention, with the matched span emphasised. This is the
  evidence for the detection, and it is what an editor actually skims.
- **Flag badges** — colour-coded, on the right.

### 5.2 Flags

| Flag | Colour | Meaning | Default |
|------|--------|---------|---------|
| `low_confidence` | amber | Below the confidence threshold | enabled |
| `overlap` | amber | Conflicts with the next cue and could not be truncated safely | enabled |
| `truncated` | grey | Shortened to fit before the next cue | enabled |
| `long_passage` | amber | Over `max_verses_per_passage`; body truncated | enabled |
| `text_unavailable` | red | Verse text could not be fetched | **disabled** |
| `passage_not_found` | red | Provider has no such passage | **disabled** |
| `chapter_only` | amber | No verse specified, so no body text | **disabled** |
| `suppressed_duplicate` | grey | Repeat of an earlier cue inside the cooldown | **disabled** |
| `cut_from_edit` | grey | This moment is not in the current edit | **disabled** |
| `multiple_placements` | amber | The media appears more than once; anchored to the earliest | enabled |
| `speed_change_unsupported` | red | Segment has a speed change; mapping is unreliable | **disabled** |

Every red or amber default-disabled flag is *recoverable by the editor in one click* — nothing
is hidden, it just starts off.

### 5.3 Expanded row

Clicking the row body expands it:

```
┌──────────────────────────────────────────────────┐
│ Reference  [ 1 Corinthians 6:19-20        ] [↻]  │
│ Verse text (KJV)                                 │
│   19 What? know ye not that your body is the     │
│   temple of the Holy Spirit which is in you…     │
│                                                  │
│ Transcript context                               │
│   …and this is why it matters. Turn with me to   │
│   ▸First Corinthians six, nineteen and twenty◂.  │
│   Or do you not know that your body is the…      │
│                                                  │
│ Timing   anchor 00:23:45:11  [-1f] [+1f] [⌖]     │
│          duration [ 27.1 ] s        read 78%     │
│ Classification  READ (coverage 0.78)             │
│                                          [Delete]│
└──────────────────────────────────────────────────┘
```

- **Reference field** is editable. `↻` re-resolves via `POST /resolve`, replacing the verse text
  and recomputing the paraphrase duration. Invalid references show the canon-validation error
  inline.
- **Verse text** is read-only, and shows the truncation point when `long_passage` is set.
- **Transcript context** shows ~15 words either side with the matched span marked. When a read
  span was found, its extent is underlined — so the editor can see exactly what the classifier
  matched, which is the honest way to present a 78% coverage number.
- **`[-1f] [+1f]`** nudge the anchor a frame at a time; **`⌖`** sets it to the current playhead
  (FR-6.3). Both re-run overlap resolution across the list.
- **Duration** override, per cue.
- **Delete** removes the cue. Undo is via re-analysing or reloading a saved document — cheap
  enough not to need an undo stack.

### 5.4 List actions

- **All / None / Flagged only** — bulk enable, disable, filter.
- **Add cue** — a reference plus the current playhead (FR-6.4). Origin `manual`, confidence 1.0.
- **Save ▾** — *Save cue document* (JSON, FR-6.8), *Load cue document*, *Export as VerseFlow
  .txt*. The last one writes the format VerseFlow's parser reads, so the same content can be
  run through the old tool — a genuine escape hatch, and nearly free given
  [06](06-bible-text-service.md) §2's formatting contract.

---

## 6. Insert

**Insert N scriptures** carries the enabled count (FR-6.7). Before running, the panel calls
`VS.validateTrack`; if existing clips would be overwritten it confirms first:

> *3 of your cues will overwrite existing clips on V3. Continue?*

During insert: progress from the `com.versesync.progress` CSXS events, setup and review
controls disabled, the button showing `Inserting… 7 / 16`.

After: a summary line — `Placed 16 of 16.` or `Placed 14 of 16 — 2 failed, see details.` — with
failures expandable per cue. Review state is retained, so a partial failure can be fixed and
re-run on only the affected cues.

**One Ctrl+Z reverts the whole batch.** Say so in the summary line the first time it happens.

---

## 7. Empty and edge states

| State | What the panel shows |
|-------|----------------------|
| Before any analysis | Setup only; review area shows *Select a media file and click Analyse.* |
| Analysis found nothing | *No scripture references found. Check the audio has speech, or try a larger model.* with a link to the transcript |
| Media not in the sequence | *SERMON_A001.MXF isn't in this sequence.* + **Enter a start timecode manually** ([05](05-timing-and-placement.md) §5.4) — if the selected file looks like a multicam or nested-sequence name rather than a flat audio/video file, add: *If this is a multicam or nested sequence, select the sermon's audio file instead.* |
| All cues disabled | Insert disabled, *Enable at least one scripture to insert.* |
| Bible provider down | Cues listed with `text_unavailable`; a banner offers **Retry text fetch** |
| Job failed | The sidecar's `message` verbatim plus its `hint`, and a **Retry** button |

---

## 8. Visual language

Follow Premiere's dark UI, as VerseFlow's `css/style.css` already does. Reuse its variables and
control styling rather than inventing a second look inside the same application.

- Flag colours: amber `#E8A33D`, red `#D9534F`, grey `#8A8A8A` — legible on Premiere's dark
  greys, and distinguishable without relying on colour alone (every flag also has a text label).
- The classification badge is text, not colour-only.
- Confidence is a number, not a bar. Editors want to compare rows quickly.
- Row height stays under ~64 px collapsed so a dozen cues fit in a docked panel.

---

## 9. What the UI deliberately does not do

- **No MOGRT preview.** VerseFlow's HTML/CSS mock (its decision D2) was for a single scripture
  before insert. Here the editor reviews eighteen cues; a per-row approximate render is noise.
  The expanded row shows the real verse text, which is the thing that can actually be wrong.
- **No waveform.** Tempting for timing confidence, but Premiere is *right there* — clicking a
  timecode to scrub is better than a small waveform in a 340 px panel.
- **No inline transcript editor.** Correcting the transcript would invalidate every downstream
  timestamp. Editors correct *references*, not words.
- **No settings screen.** The three constants worth touching are in Setup; the rest live in
  `config.yaml` where they belong (FR-8.1).
