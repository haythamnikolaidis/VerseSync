# Spikes — notes

## T-01 — Reference assets

**Received:**
- `AV_Quote_04.mogrt` → `assets/test/AV_Quote_04.mogrt`
- A full sermon media set + its Premiere project → `assets/test/sermon/`

**Q-D — editor's actual ingest ([12-decisions-and-risks.md](../docs/12-decisions-and-risks.md)):**

- **Video (4 files):** three individual camera files plus one recorded Program/Visual Mix
  (switcher output). All four are synced together via PluralEyes into one sequence, which is
  then converted into a **multicam clip** for editing.
- **Audio:** a separate, standalone audio file — detached from all video sources, not one of
  the four video files.
- **Filenames are not predictable.** The audio file's name varies depending on who is
  preaching that week, so nothing downstream (T-04, T-07) may identify the sermon audio by
  filename pattern — it must be identified by track role/position in the sequence instead.

**Implication for T-04:** the edit sequence VerseSync actually sees is a **multicam clip**
with **detached audio** — both are required test constructs in
[T-04](../docs/tasks/T-04-spike-media-segments.md#steps), and per that spec, multicam
`getMediaPath()` behavior is unverified going in. Test against this real multicam sequence,
not just the pre-multicam synced clips.

**Baseline verification:** VerseFlow confirmed working, actively in use, inserting 10 sample
scriptures into a real sequence on the dev machine (T-01 done-when item).
