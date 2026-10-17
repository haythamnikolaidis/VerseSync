"""The ``detect()`` entry point (docs/04-reference-detection.md sections 6 and 7).

Pipeline: normalize, find_candidates, validate, score, suppress duplicates, number the results.
No detection is ever discarded for low confidence (D4); ``low_confidence`` is assigned later by
the cue builder, once the timing stage's corroboration bonus is known.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from versesync.detect.canon import Canon, load_canon
from versesync.detect.confidence import score
from versesync.detect.grammar import Candidate, GrammarConfig, find_candidates
from versesync.detect.normalize import normalize
from versesync.detect.validate import validate
from versesync.types import Reference, Word

SNIPPET_WORDS = 5  # words of context kept on each side of the match (04 section 7)
ELLIPSIS = "…"
FLAG_CHAPTER_ONLY = "chapter_only"
FLAG_SUPPRESSED = "suppressed_duplicate"
DEFAULT_ALTERNATIVE_REASON = "alternative reading"


@dataclass(frozen=True)
class DetectConfig:
    grammar: GrammarConfig = GrammarConfig()
    max_range: int = 30
    duplicate_cooldown_s: float = 60.0


@dataclass(frozen=True)
class Detection:
    id: str  # "det_001", numbered in source_start order
    candidate: Candidate
    reference: Reference  # validated
    confidence: float  # before the timing stage's corroboration bonus
    validation_score: float  # 1.0, or 0.5 if valid only after an alternative reading
    flags: tuple[str, ...]  # only 'chapter_only' and/or 'suppressed_duplicate'
    snippet: str
    alternatives: tuple[tuple[Reference, float, str], ...]  # (reference, confidence, reason)

    def to_json(self, canon: Canon) -> dict[str, Any]:
        """The 04 section 7 shape."""
        c = self.candidate
        return {
            "id": self.id,
            "reference": self.reference.to_json(),
            "display": self.reference.display(canon),
            "pattern": c.pattern,
            "contextual": c.contextual,
            "token_span": list(c.token_span),
            "word_span": list(c.word_span),
            "source_start": c.source_start,
            "source_end": c.source_end,
            "snippet": self.snippet,
            "confidence": self.confidence,
            "book_match": {"tier": c.book_match.tier, "distance": c.book_match.distance},
            "alternatives": [
                {"reference": ref.to_json(), "confidence": conf, "reason": reason}
                for ref, conf, reason in self.alternatives
            ],
        }


def _reference(c: Candidate) -> Reference:
    return Reference(
        book=c.book.name,
        osis=c.book.osis,
        chapter=c.chapter,
        verse=c.verse,
        verse_end=c.verse_end,
    )


def _snippet(words: Sequence[Word], span: tuple[int, int]) -> str:
    first = max(0, span[0] - SNIPPET_WORDS)
    last = min(len(words) - 1, span[1] + SNIPPET_WORDS)
    text = " ".join(w.text for w in words[first : last + 1])
    return (ELLIPSIS if first > 0 else "") + text + (ELLIPSIS if last < len(words) - 1 else "")


def detect(
    words: Sequence[Word], canon: Canon | None = None, cfg: DetectConfig = DetectConfig()
) -> list[Detection]:
    """Every valid reference mention in ``words``, in ``source_start`` order."""
    canon = canon or load_canon()
    tokens = normalize(words, canon)
    candidates = find_candidates(tokens, canon, cfg.grammar)

    scored: list[tuple[Candidate, float, float]] = []
    for raw in candidates:
        valid = validate(raw, canon, cfg.max_range)
        if valid is None:
            continue
        candidate, validation_score = valid
        scored.append((candidate, validation_score, score(candidate, validation_score)))
    scored.sort(key=lambda t: (t[0].source_start, t[0].token_span))

    # Duplicates are compared against the last *kept* mention of the same reference, so a
    # speaker circling back for a minute gets one graphic and the next window starts afresh.
    last_kept: dict[Reference, float] = {}
    out: list[Detection] = []
    for index, (candidate, validation_score, confidence) in enumerate(scored, start=1):
        ref = _reference(candidate)
        flags: list[str] = []
        if candidate.verse is None:
            flags.append(FLAG_CHAPTER_ONLY)
        kept_at = last_kept.get(ref)
        if kept_at is not None and candidate.source_start - kept_at < cfg.duplicate_cooldown_s:
            flags.append(FLAG_SUPPRESSED)
        else:
            last_kept[ref] = candidate.source_start
        reason = candidate.alternative_reason or DEFAULT_ALTERNATIVE_REASON
        alternatives = tuple(
            (_reference(alt), score(alt, 1.0), reason) for alt in candidate.alternatives
        )
        out.append(
            Detection(
                id=f"det_{index:03d}",
                candidate=candidate,
                reference=ref,
                confidence=confidence,
                validation_score=validation_score,
                flags=tuple(flags),
                snippet=_snippet(words, candidate.word_span),
                alternatives=alternatives,
            )
        )
    return out
