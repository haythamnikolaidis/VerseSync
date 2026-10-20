# Host verification (T-22.H)

Verified by hand on 2026-10-20: Windows 11, unsigned debug-mode install via
`tools/install_panel.ps1` (`PlayerDebugMode=1`, DevTools on port 7781).

| Check | Result |
|---|---|
| Panel opens from Window > Extensions > VerseSync and is interactive | Pass |
| `VS.ping` on startup logs `hostApi "1.1"` (DevTools console) | Pass |
| `typeof require('http').request` in the panel context | `"function"` (D21 holds) |
| `panel/index.html?stub=1` opened from the file system: stub ping works | Pass |

## Findings

- **`VS` is not a panel global in Premiere.** It lives in ExtendScript; the panel reaches it
  through `evalScript`. The check is the `[VerseSync] VS.ping ...` line that `app.start()` logs.
- **The stub needs `?stub=1`.** `index.html` loads `CSInterface.js`, so a plain file open
  looks like CEP and leaves the stub off. Open `panel/index.html?stub=1` in Chrome.
- **Relative `require` breaks in CEP.** Under Premiere's Node, `require('./x.js')` from a
  `<script>` resolves against `index.html`, not `js/`. `setup.js` and `insert.js` required
  `./state.js` first and threw, which stopped `main.js` before the ping. They now prefer the
  `<script>`-loaded global (`root.VSState`) and fall back to `require`.
- **Expected console noise:** `host-stub.js` reports `ERR_FILE_NOT_FOUND` in Premiere because
  the installer deliberately excludes it while `index.html` still references it.

This closes the Wave 0 sub-clause in [13 §5](../13-technical-plan.md).

# Host verification on real Premiere (T-25.H)

Run 2026-10-20 on Premiere Pro 26.5.0, sequence `2026-10-18 Sermon` (25 fps), template
`AV_Quote_04.mogrt`, using `tools/host_verify_console.js` from the panel's DevTools console.

| # | Check | Result |
|---|---|---|
| 1 | `getSequenceInfo`: real `timebase`, `sequenceId` stable across calls | **Pass.** `timebase` `10160640000` (25 fps); `sequenceId` identical across separate `evalScript` calls, so D20's assumption holds. |
| 2 | `getMogrtFields`: two `Text` fields, distinct indices, group-qualified labels | **Fixed, re-verify.** Indices 3 and 7. `group` came back empty: 26.5 reports no `propertyType`, so the group test never fired. Group headers have a `<guid>;<hex>` string value, which the host now uses. Expect `Title Main > Text` and `Description > Text`. |
| 3 | `getMediaSegments` on the real edit | **Pass.** The lapel WAV gives 4 contiguous audio segments on track 0 (speed 1); the nested multicam video comes back in `unsupported` as `unresolvable_media`, as T-04 documents. Walk time **22 ms**. |
| 4 | `insertCues`: 20 cues at 20 times, text and durations right, one Ctrl+Z | **Placement pass; undo fails.** All 20 land with the right text (once the real indices 3 and 7 are mapped) but Ctrl+Z needs **20 presses**. `app.beginUndoGroup`, `app.endUndoGroup` and `app.project.beginUndoGroup` are all `undefined` in 26.5. Accepted for v1: **D25**. |
| 5 | A broken cue is reported, the rest still land | **Fixed, re-verify.** A cue that threw after `importMGT` left a default-text clip on the track. The host now removes the half-built clip before reporting the failure (`insert-cues.test.js`). |
| 6 | Sequence switch between Analyse and Insert gives the D20 message and inserts nothing | **Pass.** `The active sequence changed since this analysis. Switch back to "2026-10-18 Sermon" or click Analyse again.` |
| 7 | `validateTrack` reports conflicts on a populated track | **Pass.** Track 3 reported 3 conflicts (`AV Quote 04`). |

## Findings

- **No undo group on 26.5 (D25).** The host's `beginUndoGroup`/`endUndoGroup` calls are
  try-wrapped, so they fail silently. FR-7.4 and G5 are not met in v1; docs, the panel's summary
  line and the test script now say Ctrl+Z removes graphics one at a time. Revisit from user
  feedback (*Undo last insert* or UXP, R-3).
- **26.5 MOGRT properties have no `propertyType` or `name`.** Text fields are found by their
  `textEditValue` value; groups by the guid-prefixed value. The nearest header above a field is
  its group (headers carry no depth).
- **`getMediaSegments` cannot see inside nested sequences.** Confirmed again on the real edit.
  The sermon audio is a detached WAV, so this does not affect matching.
