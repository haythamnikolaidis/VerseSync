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
│   Scripture file  [ Select… ] (optional)   │
│   Template        [ Select… ] AV_Quote_04  │
│     Reference →   [ Description > Text  ▾] │
│     Scripture →   [ Title Main > Text   ▾] │
│   Translation     [ King James (KJV)    ▾] │
│   Target track    [ V3 ▾ ]      [Refresh]  │
│   Duration        (•) Auto  ( ) Fixed [ ]s │
│   Lead-in         [ 0.5 ] s                │
│   [x] Auto-wrap scripture text             │
│   Max chars / line      [ 80 ]             │
│   Max lines / graphic   [ 4 ]              │
│   Adjust to fit your template's text box.  │
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

Field-by-field behaviour. Everything except the media file and the scripture file persists between
sessions (FR-1.7), so a weekly run is: pick media, click Analyse.

| Control | Behaviour |
|---------|-----------|
| **Media file** | `window.cep.fs.showOpenDialog` filtered to audio/video extensions — **not** ExtendScript `File.openDialog`, which fails in Premiere 2026 (VerseFlow's finding). Shows basename, full path on hover. |
| **Scripture file** | Optional. *Scripture file (EasyWorship export)*, under the media file: the same `cep.fs.showOpenDialog` call as the media picker, filtered to `txt`, with a **Clear** button once a file is chosen. The dialog opens in the media file's folder; with no media chosen it opens in the folder of the last scripture file picked this session, and otherwise where the host last left it. The path travels as `options.scripture_file` ([14](14-scripture-file-import.md) §6) and is left out of the request when nothing is chosen. It is per sermon, like the media file, so it is not restored on restart. It never gates Analyse. A `scripture_file_*` input error from the sidecar shows its message like any other job error (§7). |
| **Template** | `.mogrt` picker. On selection, calls `VS.getMogrtFields` with a *Reading template…* busy state. Zero fields → the VerseFlow warning about After Effects–authored templates (FR-1.4). |
| **Reference / Scripture dropdowns** | Populated with group-qualified labels (`Description > Text`), values are field **indices**. VerseFlow's smart defaults apply: reference ← group matching `/descr\|caption\|sub\|credit\|author/i`, body ← `/title\|main\|quote\|body/i`. Same field for both is a validation error. Persisted per MOGRT path. |
| **Translation** | From `GET /translations`. Shows the licence attribution beneath it in small type, if the translation has any (FR-4.7). Disabled while the sidecar is unreachable. |
| **Text layout** | *(T-54)* **Auto-wrap scripture text** (default on), **Max chars / line** (default 80, 20–120) and **Max lines / graphic** (default 4, 1–12), with the hint *Adjust to fit your template's text box.* Out-of-range values clamp, as Lead-in does. Unticking the checkbox disables both numbers. They persist with the other settings and are not sent in the job request or stored in the Cue Document. Applied at insert, so they never gate Analyse, and changing one updates the review rows (§5.1, §5.3) at once, with no new analysis. See [15](15-graphic-text-layout.md). |
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

The core screen. Sorted by sequence timecode. A job made from a scripture file adds source badges,
one kind of row that needs a time, and one collapsed group (§5.5); a job without one looks exactly
as described in §5.1–§5.4 and shows none of them.

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
- **Source badges** — only on a cue from a scripture file, after the duration: **EW** with the
  export's translation (`EW KJV`) on a cue whose `text_source.kind` is `export`; **Repeat** on
  `repeat_read` and `repeat_mention`; **Out of order** on `out_of_order`. A cue whose text came from
  the Bible provider, or a v1 cue, has none. The flag of the same name sits on the right as well
  (§5.2), so the flagged count and the Flagged filter include these rows.
- **Confidence** — percentage. Below the threshold (0.55) it is amber.
- **Duration** — resolved seconds.
- **Snippet** — the transcript around the mention, with the matched span emphasised. This is the
  evidence for the detection, and it is what an editor actually skims.
- **Flag badges** — colour-coded, on the right.
- **Layout** — only on a cue that will split into several graphics ([15](15-graphic-text-layout.md)
  §3), on a line of its own under the badge line: *Inserts as 3 graphics*. If any part would be
  visible for less than `min_visible_s` (2.0 s) the line adds an amber *⚑ Part under 2 s*; the part
  still inserts. This is a warning on the line, not a flag: it is not in the flagged count and
  **Flagged only** ignores it. A cue that fits one graphic has no such line, so its row is exactly
  as above. A split cue is still one row, ticked, edited and nudged as a whole. The line follows the
  Setup text-layout controls (§3), the cue's timing and its text, and appears or goes as they change.

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
| `not_in_export` | grey | Detected in the audio but not in the scripture file; shows provider text. Listed under *Other mentions (N)* (§5.5) | **disabled**; ticking it enables it |
| `not_found_in_audio` | amber | A scripture-file entry the audio never reached; its time is a guess. Reads *Not found in audio — set the time* (§5.5) | **disabled**, and **cannot be enabled** until the editor sets a time |
| `repeat_mention` | grey | The pastor named an export scripture again with no new slide. **Repeat** badge | **disabled** |
| `repeat_read` | grey | The pastor read an export scripture again with no new slide. **Repeat** badge | enabled |
| `out_of_order` | amber | An export entry read earlier than the file's order puts it. **Out of order** badge | enabled |
| `cut_from_edit` | grey | This moment is not in the current edit | **disabled** |
| `multiple_placements` | amber | The media appears more than once; anchored to the earliest | enabled |
| `speed_change_unsupported` | red | Segment has a speed change; mapping is unreliable | **disabled** |

Every red or amber default-disabled flag is *recoverable by the editor in one click* — nothing
is hidden, it just starts off. The one exception is `not_found_in_audio`: it takes a time, not a
click (§5.5), because the cue has none worth inserting.

A flag's label is its name in words (`not found in audio`, `repeat read`, `out of order`), so none
relies on colour alone.

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
- **Parts** — only on a cue that will split (§5.1): *Inserts as N graphics*, then one block per graphic
  in the order they will play, headed *Part n · HH:MM:SS:FF* with the sequence timecode the part
  starts at, and its text on separate lines as they will break on the graphic. A part under
  `min_visible_s` carries the amber *⚑ Part under 2 s*. The first part starts at the cue's
  timecode; a cue the media does not reach (*cut from edit*) lists its parts without times. The
  block sits under the verse text, which still shows the stored text once. When a Setup layout
  control changes the block is redrawn in place and the row stays open; a nudge or a duration edit
  redraws the list as it always has, with the row still open, and the parts' times move with the
  cue's.
- **Transcript context** shows ~15 words either side with the matched span marked. When a read
  span was found, its extent is underlined — so the editor can see exactly what the classifier
  matched, which is the honest way to present a 78% coverage number.
- **`[-1f] [+1f]`** nudge the anchor a frame at a time; **`⌖`** sets it to the current playhead
  (FR-6.3). Both re-run overlap resolution across the list. A `not_found_in_audio` row also has a
  **Time** field here (§5.5).
- **Duration** override, per cue.
- **Delete** removes the cue. Undo is via re-analysing or reloading a saved document — cheap
  enough not to need an undo stack.

### 5.4 List actions

- **All / None / Flagged only** — bulk enable, disable, filter. **All** skips the cues that cannot
  be enabled yet (§5.5), so it never ticks a `not_found_in_audio` cue.
- **Add cue** — a reference plus the current playhead (FR-6.4). Origin `manual`, confidence 1.0.
- **Save ▾** — *Save cue document* (JSON, FR-6.8), *Load cue document*, *Export as VerseFlow
  .txt*. The last one writes the format VerseFlow's parser reads, so the same content can be
  run through the old tool — a genuine escape hatch, and nearly free given
  [06](06-bible-text-service.md) §2's formatting contract.

### 5.5 Scripture-file rows

Only a job made from a scripture file ([14](14-scripture-file-import.md) §7) has these. Every other
row, and every row of a v1 document, is exactly as described above.

- **Order.** The list stays in timecode order. A row for an entry the pastor read early
  (`out_of_order`), read again (`repeat_read`) or never reached (`not_found_in_audio`, at its
  guessed time) sits where its time puts it. Only `not_in_export` cues are set apart.
- **Not found in audio.** A `not_found_in_audio` row shows an amber line, *Not found in audio — set
  the time*, in place of a snippet. Its checkbox is disabled, with that line as its reason, so it
  cannot be ticked; **All** skips it, and Insert refuses it if a hand-edited document enables it.
  Opening the row focuses its **Time** field in the Timing section, which takes a sequence timecode
  (`HH:MM:SS:FF`, as the rows display them) and **Set**, and **⌖** takes the playhead as before. The
  anchor shown is labelled *(a guess)* and the nudges stay off until a time is set. Setting the time
  by any of these removes the `not_found_in_audio` flag and enables the cue in the same edit, and
  the row becomes an ordinary one. A typed time that isn't a timecode or isn't over the media shows
  its message under the Timing section and changes nothing. A saved cue document keeps the flag
  while it stands, and the cleared flag and the enabled cue once the time is set.
- **Other mentions (N).** `not_in_export` cues are not in the main list. They sit in a group after
  it, headed *Other mentions (N)* with N the number of such cues, **collapsed** until the editor
  opens it. Its rows are ordinary rows: ticking one enables it like any other cue, it counts in
  *N enabled* and in the Insert button, and it keeps its flag and its place in the group. The group
  is left out when N is 0, and it stays as the editor left it (open or shut) when the list redraws.
  *N found* in the header still counts every cue, and **Flagged only** leaves the group as it is,
  because these cues all carry a flag.

---

## 6. Insert

**Insert N scriptures** carries the enabled count (FR-6.7), which counts cues, not graphics. Each
enabled cue goes in as one graphic or, when it will split (§5.1), as several, laid back to back
across the cue's time ([15](15-graphic-text-layout.md) §4). The first keeps the cue's id and a later
part is `<cue id>#<n>`, so the second graphic of `cue_003` is `cue_003#2`. Every part keeps the full
reference. The Cue Document is not changed: its `body` stays as it was and the line breaks exist only
in what is sent to the template.

Before running, the panel calls `VS.validateTrack` with a range for every graphic; if existing clips
would be overwritten it confirms first. The sentence counts cues, so a cue whose parts land on two
clips counts once:

> *3 of your cues will overwrite existing clips on V3. Continue?*

During insert: progress from the `com.versesync.progress` CSXS events, setup and review
controls disabled, the button showing `Inserting… 7 / 16`.

After: a summary line — `Placed 16 of 16.` or `Placed 14 of 16 — 2 failed, see details.` — with
failures expandable per cue. The numbers and the progress count are **graphics**. When any cue was
split the line says so — `Placed 18 of 18 graphics.` — so 18 is not read as a count of cues, and a
failed graphic is named by its cue and part: *Psalm 23:1-4 (KJV), part 2 of 2 — <host message>*.
Review state is retained, so a partial failure can be fixed and re-run on only the affected cues
(**Retry failed** sends just the failed graphics).

**One Ctrl+Z reverts the whole batch.** *Not available in v1: Premiere 26.5 has no undo-group
API, so Ctrl+Z removes one inserted graphic per press (D25). Do not claim one-press undo in the
summary line.*

---

## 7. Empty and edge states

| State | What the panel shows |
|-------|----------------------|
| Before any analysis | Setup only; review area shows *Select a media file and click Analyse.* |
| Analysis found nothing | *No scripture references found. Check the audio has speech, or try a larger model.* with a link to the transcript |
| Media not in the sequence | *SERMON_A001.MXF isn't in this sequence.* + **Enter a start timecode manually** ([05](05-timing-and-placement.md) §5.4) |
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
- Row height stays under ~64 px collapsed so a dozen cues fit in a docked panel. A split cue's row
  adds its layout line (§5.1).

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
