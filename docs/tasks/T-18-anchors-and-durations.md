# T-18 · Anchors and durations

**Executor** agent · **Size** S · **Prereqs** T-17.2, T-43 · **Status** todo

| | |
|---|---|
| **Workstream** | E — Timing |
| **Unblocks** | T-19 |
| **Spec** | [05-timing-and-placement.md §2, §3, §9](../05-timing-and-placement.md) · [04 §6](../04-reference-detection.md) (the corroboration bonus) |

## Goal

Compute each cue's **anchor in source seconds**, its duration, and its final confidence. The
anchor is the number the whole product exists to get right.

## Read

[05 §2](../05-timing-and-placement.md) (the config table) ·
[05 §3](../05-timing-and-placement.md) · [05 §9](../05-timing-and-placement.md) (the worked
example) · `reference/verseflow/js/duration.js` (the whole file is small)

## Touches

`sidecar/versesync/timing/anchor.py` (new) · `tests/test_anchor.py` (new)

## Interface

```python
@dataclass(frozen=True)
class TimingConfig:
    lead_in_s: float = 0.5; tail_pad_s: float = 1.0
    duration_mode: str = "auto"           # 'auto' | 'fixed'
    fixed_duration_s: float = 8.0; min_duration_s: float = 3.0; max_duration_s: float = 20.0
    max_read_duration_s: float = 45.0; read_lookbehind_s: float = 20.0
CORROBORATION_BONUS = 0.10

@dataclass(frozen=True)
class Timing:
    source_anchor_s: float; source_duration_s: float; confidence: float

def paraphrase_duration(word_count: int, cfg: TimingConfig) -> float   # VerseFlow duration.js, ported
def compute_timing(mention_start_s: float, alignment: Alignment | None,
                   body_word_count: int | None, confidence: float,
                   cfg: TimingConfig = TimingConfig()) -> Timing
```

## Rules

- **Anchor:** `anchor = min(mention_start, read_start) - lead_in`, floored at 0. `read_start`
  counts only if the alignment is `read` **and**
  `mention_start - read_start_s <= read_lookbehind_s`.
- **Duration** (`auto`):
  - READ: `(read_end - anchor) + tail_pad`, clamped to `[min, max_read]`;
  - PARAPHRASE with a body: `paraphrase_duration(word_count)`;
  - **no body** (unresolved, or chapter-only): `fixed_duration_s` ([05 §4.3](../05-timing-and-placement.md)).

  `fixed` mode always uses `fixed_duration_s`.
- **Confidence:** add `CORROBORATION_BONUS` when the alignment is `read`, capped at 1.0.
- Round the anchor and the duration to **3 decimals** (milliseconds) so the output is stable.

## Steps

1. Port `paraphrase_duration` from `reference/verseflow/js/duration.js`: 160 wpm, + 1.5 s,
   rounded to 0.1, clamped to [3, 20]. Test it with at least 6 word counts, and assert the
   expected values computed **by hand from the JS formula**. Cite the vendored file in a
   comment. Commit: `T-18 [1/3] paraphrase duration`.
2. Write `compute_timing`, with all three duration branches and the anchor rule. Test:
   - mention first;
   - reading first;
   - a reading 25 s before the mention, which is ignored;
   - the anchor never goes below 0 (mention at 0.2 s);
   - the 45 s cap.

   Commit: `T-18 [2/3] compute_timing`.
3. Reproduce the **[05 §9] worked example** exactly as a test: mention 1425.82, read
   1428.9–1451.4, confidence 0.91 → anchor **1425.32**, duration **27.08**, confidence
   **1.00**. Commit: `T-18 [3/3] worked example`.

## Verify

`pytest tests/test_anchor.py -q`

## Done when

- [ ] The worked example reproduces exactly.
- [ ] Both orderings anchor correctly, and the lookbehind limit is respected.
- [ ] PARAPHRASE durations match VerseFlow's formula for the tested word counts.
- [ ] There's no tick or frame arithmetic anywhere in this file.

## Traps

- Duration is measured from the **anchor**, not from `read_start`.
- Everything here is in seconds. A tick or a frame in this file is a design violation.
