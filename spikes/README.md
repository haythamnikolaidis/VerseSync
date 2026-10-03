# Spikes

Gated risk spikes from [10-tasks.md](../docs/10-tasks.md) / Wave 0. Each has
its own directory with the test script and a `RESULTS.md`.

## Running these against Premiere

We reuse VerseFlow's existing debug-mode CEP panel to drive ExtendScript
rather than standing up a separate VerseSync extension for spike work —
VerseFlow is already registered (`PlayerDebugMode=1`, debug port `7778`) and
its panel already loads `CSInterface.js`. Each spike's own `.jsx` is
self-contained (no dependency on `VF.*`) and gets loaded into the same
ExtendScript engine via `$.evalFile()` from the panel's DevTools console. See
each spike directory's `console-driver.md` for the exact steps.

## T-01 — reference assets

- `.mogrt`: received, at `assets/test/AV_Quote_04.mogrt` (gitignored).
- Sermon media + Premiere project: received, at `assets/test/sermon`
  (gitignored).
- Q-D (ingest shape — camera audio vs. separate recorder vs. merged/multicam):
  **answered by T-04's real data** — the sermon audio is a separate lapel-mic
  recording (`03-Pastor Lapel-260927_0935.wav`), detached from camera
  footage. Confirmed resolving cleanly as the "detached audio" construct.
  The edit also uses nested sequences, multicam (nested), and speed changes;
  no merged clips.
- VerseFlow known-good baseline (10 scriptures into a real sequence):
  implicitly confirmed — T-03's `importMGT` calls against the real
  `AV_Quote_04.mogrt` worked throughout.

## Spikes

| | Question | Status |
|---|---|---|
| [T-02](../docs/tasks/T-02-spike-word-timestamps.md) | word-level timestamp accuracy | not started |
| [T-03](absolute_insert/) | `importMGT` overwrite vs. ripple | **done** — overwrite confirmed, see [RESULTS.md](absolute_insert/RESULTS.md) |
| [T-04](media_segments/) | media segment resolution (merged/multicam/nested) | **done** — see [RESULTS.md](media_segments/RESULTS.md) |
