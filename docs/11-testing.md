# 11 — Testing Strategy

VerseSync has an unusual testing shape: the part most likely to be wrong (detection and timing)
is also the part that is pure, deterministic and completely testable without Adobe software.
The strategy leans hard on that.

```
        cheap, fast, run on every commit
   ┌──────────────────────────────────────────┐
   │  unit tests — detection, timing, format  │   Python + JS, no Premiere, no network
   ├──────────────────────────────────────────┤
   │  golden-file tests — transcript → cues   │   fixture transcripts, checked-in expected output
   ├──────────────────────────────────────────┤
   │  accuracy harness — M1/M2/M3 metrics     │   the 10-sermon corpus, run before release
   ├──────────────────────────────────────────┤
   │  integration — sidecar over HTTP         │   real service, mock provider
   ├──────────────────────────────────────────┤
   │  manual QA — the script in §6            │   real Premiere, real sermon
   └──────────────────────────────────────────┘
        expensive, slow, run before release
```

---

## 1. Unit tests (Python)

No network, no GPU, no Premiere. These run in seconds and are the safety net for every
algorithmic change.

**Normalisation and numbers** (T-10)
- Every spoken-number form to 176: units, teens, compounds (`twenty eight`), hundreds
  (`one hundred and nineteen`), and mixed digit/word transcripts.
- Ordinal prefixes: `first Corinthians`, `1 Corinthians`, `one Corinthians`, `II Timothy`.
- Token→word back-references survive normalisation; a token span maps back to the right source
  seconds. **This is the test that catches the most damaging class of bug** — everything
  downstream is timestamps, and a mis-mapped span is invisible until it places a graphic in the
  wrong place.

**Book matching** (T-11)
- Exact names, plural aliases (`Revelations`, `Psalms`), abbreviations.
- Every seed entry in the ASR-confusion table.
- Fuzzy matches at distance 1 and 2, and non-matches at distance 3.
- **Negative fixtures** — the gate that keeps precision alive:
  - "he lost his **job** last year"
  - "faith without works **acts** dead"
  - "**mark** my words"
  - "the **numbers** don't lie"
  - "he was a **judge** for thirty years"
  - "in the book of life" (no book name at all)
  - "**Romans** were known for their roads" — a real book name with no number following
  - "**John** turned forty last week" — book name *with* a number following, which must be
    caught by canon validation (John has 21 chapters) or confidence, not by the gate
- Short high-frequency names never fuzzy-match.

**Grammar** (T-12)
- Every pattern P1–P12 with at least three phrasings each.
- Priority: `john 3 : 16 - 18` matches P1, not P2 then a stray number.
- Context carry: works inside the window, expires outside it, and does not leak across a
  different intervening book.
- Psalms ambiguity: `psalm one nineteen` yields both readings with the concatenated form
  preferred.

**Canon validation** (T-13)
- `Jude 5:1` rejected (one chapter). `Psalm 151:1` rejected. `Psalm 119:176` accepted.
  `Obadiah 1:21` accepted, `Obadiah 1:22` rejected.
- Reversed ranges swap when the swap validates.

**Alignment** (T-17)
- Verbatim reading → coverage ≥ 0.9.
- Reading with interjections ("For God so loved — and church, hear this — the world") →
  still READ.
- Genuine paraphrase → coverage ≤ 0.35.
- Reading *before* the reference is named → `read_start` precedes `mention_start`.
- Empty verse text (unresolved passage) → skipped cleanly, classified PARAPHRASE.

**Anchors and durations** (T-18)
- The worked example in [05](05-timing-and-placement.md) §9 reproduces to the millisecond.
- Lead-in never produces a negative anchor.
- READ duration respects `max_read_duration_s`; PARAPHRASE matches VerseFlow's `duration.js`
  output exactly for the same word count — **assert against VerseFlow's constants directly**,
  so a drift in either project is caught.

**Formatting** (T-14)
- The **round-trip test**: `Passage` → VerseFlow `.txt` block → VerseFlow's parser regex →
  identical reference, translation and body. Non-negotiable; it is the whole interop contract
  in [06](06-bible-text-service.md) §2.
- Markup stripping: HTML tags, footnote markers, red-letter spans, paragraph markers.
- Verse numbers retained; whitespace collapsed.

---

## 2. Unit tests (JavaScript, panel)

`timemap.js`, `cues.js` and `duration.js` are pure and must be tested in a plain Node/browser
harness with no CEP and no Premiere.

- **Source→sequence mapping**: zero, one and many candidate segments; a time before `inPoint`;
  a time past the segment end; trimmed heads and tails.
- **Frame snapping**: 23.976, 24, 25, 29.97, 30, 50, 59.94 timebases; snapping is idempotent;
  40 sequential snaps accumulate no drift.
- **Overlap sweep**: silent truncation; truncation refused below `min_visible_s`; three-way
  overlaps; cues that exactly abut.
- **Cue model**: enable/disable counting, edit invalidation, manual cue construction, Cue
  Document load with an unknown minor version (warn) and an unknown major version (refuse).

---

## 3. The fixture corpus

Detection cannot be tuned without labelled data, and the corpus is a deliverable in its own
right — build it early (during M2), not at M5 when the metrics are due.

**Required contents:**

| Item | Requirement |
|------|-------------|
| Sermons | **≥ 10**, ≥ 3 different speakers, ≥ 30 min each |
| Labelled utterances | **≥ 300** scripture mentions, each with a canonical reference and a frame-accurate start time |
| Form coverage | Every form in [04](04-reference-detection.md) §4 present **≥ 5 times** |
| Read/paraphrase | Both classes labelled; ≥ 50 of each |
| Audio quality | ≥ 2 sermons with degraded audio — room mic, applause, music bed |
| Negative passages | Transcript sections containing book-name homographs as ordinary words |
| Edit variants | ≥ 2 sermons with a *second* Premiere sequence that recuts the same media, for Journey B |

**Labelling protocol.** One annotator marks the reference and the start frame of the first
spoken word of the mention (or of the reading, when it comes first). A second annotator checks a
10% sample; disagreements over 0.25 s are adjudicated and the rule that resolved them is written
down. Without this, M3's ±0.5 s target is measured against noise.

**Storage.** Media files are large and are church property — keep them **out of the repository**
on a shared drive, with only the *transcripts*, *labels* and *expected Cue Documents* checked
in. That also means most tests run without the audio.

---

## 4. Golden-file tests

The bridge between unit tests and the full harness: checked-in transcript fixtures with
checked-in expected Cue Documents.

- Run the pipeline from a stored word array (no Whisper, no GPU) through detection, resolution
  against the local provider, and timing.
- Diff against the expected Cue Document, ignoring `generated_at` and job ids.
- A deliberate change to a threshold should show up as a **reviewable diff** in the golden
  files, which is exactly what makes T-34's tuning safe.

This is also the determinism test (NFR-3, [05](05-timing-and-placement.md) §10): run twice,
assert byte-identical output.

---

## 5. Integration tests

**Sidecar over HTTP** — real service, real ports, a mock Bible provider, a tiny audio file:
- Auth: correct token passes, wrong token gets 401, missing origin rejected.
- Job lifecycle: submit → progress events → result; cancellation mid-job; job not found.
- Cache hit path reports `cache_hit: true` and skips the transcribing phase.
- Provider down → job **succeeds** with `text_unavailable` cues (FR-4.5), not a failed job.
- Lock file: stale lock is replaced; two sidecars cannot both claim it.
- CLI and HTTP produce identical Cue Documents for the same input (T-21).

**Host layer** — cannot be automated (no headless Premiere), so it is covered by the manual
script in §6 plus the spike evidence from T-03 and T-04.

---

## 6. Manual QA script

Run before any release, on the reference workstation, against a real sermon. Roughly 45 minutes.

**Setup**
1. Fresh Premiere, open the QA project, open a sequence containing the sermon media.
2. Open **Window ▸ Extensions ▸ VerseSync**. → Status strip shows `ready`, device and model.
3. Close and reopen the panel mid-idle. → It reattaches to the running sidecar, does not relaunch.

**Setup validation**
4. Click Analyse with nothing selected. → Disabled, with the reason shown.
5. Select a Premiere-authored `.mogrt`. → The After Effects warning appears; Insert stays disabled.
6. Select `AV_Quote_04.mogrt`. → Two fields listed with group-qualified labels; smart defaults
   select Description ▸ Text for reference and Title Main ▸ Text for body.
7. Set both dropdowns to the same field. → Validation error.
8. Restart Premiere and reopen the panel. → Template, mapping, translation, track and lead-in
   all restored.

**Analysis**
9. Click Analyse. → Phases progress; ETA appears after ~10%; the panel stays responsive.
10. Cancel mid-transcription. → Stops within ~5 s; no partial results; nothing cached.
11. Analyse again to completion. → Review list populates in timecode order.
12. Analyse a third time. → `Using cached transcript`; result in < 5 s.

**Review**
13. Click a row's timecode. → Premiere's playhead jumps there; the audio matches the snippet.
14. Expand a READ row. → Verse text, transcript context with the read span underlined, coverage
    shown.
15. Edit a reference to a different valid passage and re-resolve. → Verse text and duration update.
16. Edit a reference to an invalid one (`Jude 5:1`). → Inline validation error, no crash.
17. Nudge an anchor ±1 frame ten times. → Timecode moves exactly one frame each time.
18. Set an anchor to the playhead. → Matches, and the overlap sweep re-runs.
19. Add a manual cue. → Appears in timecode order with confidence 100%.
20. Filter to flagged only. → Only flagged rows; counts update.
21. Save the cue document, close Premiere, reopen, load it. → Every edit, disable and manual
    addition restored.

**Insert**
22. Click Insert with cues that overlap existing V3 clips. → The overwrite confirmation appears.
23. Confirm. → Progress runs; graphics land at the reviewed timecodes.
24. Scrub to three cues. → Each graphic starts as the speaker begins the reference or reading;
    reference and verse text are correct and match the review list.
25. **Ctrl+Z once.** → Every inserted graphic disappears; nothing else in the sequence moved.
26. Re-insert. → Same result, no duplicates.

**Failure modes**
27. Kill the sidecar process, then click Analyse. → Clear message and log path; **loading a saved
    cue document and inserting still works**.
28. Point the config at an unreachable Bible API and analyse. → Job succeeds; affected cues
    flagged `text_unavailable` and disabled; Retry offered.
29. Close all sequences. → Analyse and Insert both disabled with an explanation.
30. Select media that is not in the sequence. → *Not in this sequence* plus the manual-offset
    fallback.
31. Recut the sequence (move and trim the sermon clip), then re-analyse. → Anchors update to the
    new positions; cues whose moment was cut are flagged `cut_from_edit` and disabled.

---

## 7. Release gates

A build ships only when all of these hold:

| Gate | Source |
|------|--------|
| Unit and golden-file tests green | §1, §2, §4 |
| Integration tests green | §5 |
| **M1 recall ≥ 90%, M2 precision ≥ 85%, M3 anchor accuracy ≥ 90%** | accuracy harness, [00-prd.md](00-prd.md) §5 |
| No regression in any metric versus the previous release | harness diff mode |
| NFR-2 performance numbers met on the reference workstation | T-35 |
| Manual QA script §6 fully passed | manual |
| The round-trip formatting test passes | §1, T-14 |
| Clean-machine install completes from the README alone | T-36 |

---

## 8. What is not tested, and why

- **The MOGRT's visual output.** There is no Adobe API that renders a MOGRT to an image outside
  the timeline (VerseFlow's decision D2). Correctness of what lands on screen is verified by
  QA step 24, visually.
- **Whisper's accuracy itself.** Treated as an input, not a component. What is measured is
  VerseSync's accuracy *given* Whisper's output — which is what the corpus captures.
- **Premiere's own behaviour.** Characterised once in the T-03/T-04 spikes and depended on. If
  a Premiere update changes it, the manual script catches it at step 23–25.
