# T-01 · Obtain and verify the reference assets

| | |
|---|---|
| **Workstream** | 0 — Foundations |
| **Wave** | 0 — **start on day 1, external dependency** |
| **Estimate** | S (plus however long the client takes) |
| **Prereqs** | none |
| **Unblocks** | T-02, T-03, T-04 — and through them T-24, T-25 |
| **Spec** | VerseFlow `docs/planning/10-template-reference.md` · VerseFlow `README.md` |

## Goal

A real `.mogrt`, a real sermon media file, and a Premiere project containing it, on a dev
machine — with the known-good VerseFlow baseline verified before anything is built on it.

## Context you need

Neither repo contains the `.mogrt` binary (the client declined) or any sermon media. All three
spikes need them, and the spikes carry the project's two highest technical risks. **This is the
only genuinely external blocker in the plan** — chase it immediately, even though the task
itself is small.

## Steps

1. Obtain `AV_Quote_04.mogrt` from the client. Place at `assets/test/AV_Quote_04.mogrt`
   (gitignored — see T-40).
2. Obtain at least one full sermon media file **with its Premiere project**, ideally one that
   has been cut (not just a raw camera file), so T-04 sees a realistic edit.
3. Ask the editor to describe their actual ingest — is the sermon audio on the camera file, a
   separate recorder, a merged clip, a multicam clip? This is **open question Q-D**
   ([12](../12-decisions-and-risks.md)) and it decides which cases T-04 must test.
4. Install the VerseFlow panel per its README (registry debug mode, copy to
   `%APPDATA%\Adobe\CEP\extensions\VerseFlow`).
5. Insert 10 scriptures from VerseFlow's `assets/sample-scriptures.txt` into a real sequence.
   This is the **known-good baseline** every spike is measured against — it also re-verifies
   inherited risk R-7 (the MOGRT text write) on the real template.

## Files

- `assets/test/` (gitignored)
- A short note in `spikes/README.md` recording what was received and Q-D's answer.

## Done when

- [x] VerseFlow inserts 10 scriptures into a real sequence on the dev machine.
- [x] The `.mogrt` exposes two `Text` fields, in groups `Title Main` and `Description`.
- [x] A sermon media file and its Premiere project are available.
- [x] Q-D is answered in writing.

## Traps

- **Never commit the `.mogrt` or sermon media.** Client asset, and R-12 (pastoral privacy).
- If the baseline insert fails, stop and fix that first — every Premiere-side estimate in the
  plan assumes VerseFlow's technique works on this template and this Premiere build.
