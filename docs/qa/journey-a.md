# Journey A on a real workstation (T-30.H)

Run 2026-10-31 on the reference workstation: Windows 11, RTX 3080 Ti, Premiere Pro 26.5.0,
project `2026-10-25 Service.prproj`, sermon sequence for *Lacking Nothing* (2026-10-25), media
`03-Pastor Lapel-261025_0933.wav` (2 h 03 min, about 76 minutes of leading silence), template
`AV_Quote_04.mogrt`, translation KJV (the only one the sidecar serves; see Findings). The script
is [11 §6](../11-testing.md). The panel and sidecar came from a default install (`install.py`,
`tools/install_panel.ps1`).

The first pass found four panel bugs, all fixed on this branch. The affected steps were then
re-run, and the table shows the final result.

| # | Step | Result |
|---|---|---|
| 1 | Open the QA project and sequence | Pass |
| 2 | Panel opens; status `ready`, device and model | Pass, after a fix (below). The model name appears once one has been loaded. |
| 3 | Close and reopen mid-idle: reattaches, no relaunch | Pass. One `listening` line in the sidecar log until the sidecar was killed in step 27. |
| 4 | Analyse with nothing selected: disabled, reason shown | Pass |
| 5 | Premiere-authored `.mogrt`: After Effects warning | **Skipped:** no Premiere-authored template to hand. |
| 6 | `AV_Quote_04.mogrt`: group-qualified labels, smart defaults | Pass |
| 7 | Same field for both: validation error | Pass |
| 8 | Restart Premiere: settings restored | **Pass on re-run.** First run: nothing restored (fix 3). |
| 9 | Analyse: phases progress, ETA after ~10%, responsive | **Pass on re-run.** First run: elapsed stuck at 0:00 and the ETA frozen at "about 20 s left" (fix 4). |
| 10 | Cancel mid-transcription: stops within ~5 s, nothing cached | Pass |
| 11 | Analyse to completion: review list in timecode order | Pass |
| 12 | Third Analyse: `Using cached transcript`, < 5 s | Pass |
| 13 | Click a timecode: playhead jumps, audio matches | Pass |
| 14 | Expand a READ row: text, underlined span, coverage | Pass |
| 15 | Edit to another valid passage: text and duration update | Pass |
| 16 | Invalid reference (`Jude 5:1`): inline error | Pass |
| 17 | Nudge ±1 frame ten times | Pass |
| 18 | Anchor to playhead: matches, overlap sweep re-runs | Pass |
| 19 | Add a manual cue: in order, 100% | Pass |
| 20 | Filter to flagged only | Pass |
| 21 | Save, restart, load: every edit restored | **Pass on re-run.** First run: Save did nothing (fix 2). |
| 22 | Insert over existing clips: overwrite confirmation | Pass |
| 23 | Confirm: graphics land at the reviewed timecodes | Pass |
| 24 | Scrub three cues: timing, reference and text correct | Pass (text is KJV; see the accuracy counts) |
| 25 | Ctrl+Z once per graphic (D25) | Pass |
| 26 | Re-insert: same result, no duplicates | Pass |

Steps 27–31 belong to T-32.H and T-31.H. They were run in the same session and are recorded
here; those tasks own the sign-off.

| # | Step | Result |
|---|---|---|
| 27 | Kill the sidecar, Analyse: clear message; load and insert still work | **Pass on re-run.** The first run couldn't load because nothing could be saved. |
| 28 | Unreachable Bible API: job succeeds, cues flagged | **Not testable yet.** The sidecar ignores `bible.provider` (finding below). |
| 29 | Close all sequences: Analyse and Insert disabled | **Pass on re-run.** First run: both stayed enabled (fix 5). |
| 30 | Media not in the sequence: warning and manual offset | **Works as designed, but late.** The warning and the start-timecode box appear only after transcription (10–20 s). Raised as **T-52**: pick the media from the sequence's audio tracks. |
| 31 | Recut, re-analyse: anchors update, cut cues flagged | Pass |

## Accuracy spot-check (D24)

| Count | Value |
|---|---|
| Cues surfaced | 34 (11 enabled by default) |
| Unchecked because wrong | 1 |
| Added by hand because missed | 1 |
| Anchor visibly off | 0 |
| Reference edited | 1 |
| **Showing the wrong translation's text** | **all of them** |

Every cue showed KJV text while the pastor reads NKJV, NIV and TPT. This is the v1 baseline
that [T-51](../tasks/T-51-scripture-file-import.md) (the EasyWorship export, D26) is meant to
beat. The 23 cues left disabled are mostly chapter-only mentions, which D12 disables.

## Fixes made during this run

1. **The panel never started the sidecar** (`815ef7a`). `boot()` in Premiere left the client
   null and never created the lifecycle, so the status stayed at *starting transcription
   service…*. T-26 had tested `createLifecycle` on its own, and every panel test injected a
   client. `boot()` now builds the lifecycle and a `connectedClient`, which connects on first
   use and reconnects once after an idle exit.
2. **Save and load could never work in CEP.** The panel called `cep.fs.showSaveDialog`, which
   doesn't exist (only `showSaveDialogEx` does), and it passed `'utf8'` to `readFile`/`writeFile`,
   which `cep.fs` rejects with `err 5`; it needs `"UTF-8"`. The test fakes accepted both. They
   are now one shared fake with the real API's shape, listed from Premiere 26.5.
3. **Settings were lost on restart.** CEP's `localStorage` reached disk only when Premiere quit
   cleanly; the storage files showed an hour of changes held only in memory. Settings now write
   through to `%APPDATA%\VerseSync\panel-state.json` and were migrated once from `localStorage`.
4. **Elapsed and ETA didn't move.** SSE progress events carry no `elapsed_s`, and on this file
   they arrive in bursts (2% for about 20 s, then 54%, then done). The readout now keeps its own
   one-second clock.
5. **Closing every sequence left Analyse and Insert enabled.** The panel looked for a sequence
   only at startup. A 2 s watcher, paused during jobs and inserts, now keeps the status strip,
   tracks, Analyse and Insert current.

The install-path and package-data bugs that would also have stopped this run were fixed
beforehand (PR #13).

## Findings still open

- **The sidecar ignores `bible.provider`.** `sidecar.py` and `cli.py` always construct
  `LocalProvider()`, although 06 §8 makes `api_bible` the default. T-20.5's card says "local by
  default", which contradicts it. So the T-15 adapter is never used, and step 28 can't be run.
  This needs fixing before T-32.H.
- **Step 30 transcribes before it can say the media isn't in the sequence.** T-52.
