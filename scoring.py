"""Deterministic resume score, computed from the candidate's own bullets.

Three dimensions, weighted as the project documents them:

    quantification  40  the bullet states a number, percentage, amount or count
    action verbs    30  the bullet opens with a verb that claims work done
    structure       30  a readable length, no first person, no filler phrasing

Each dimension is scored per bullet and averaged, so the total is the mean
quality of what the candidate actually wrote. There are no points for having a
section heading or for uploading a file at all, and nothing here reads the
model's rewrite or its severity rating: the same resume always gets the same
score, and a rewrite can never raise the score of the text it replaced.

Like ``claims``, this module has no heavy imports so the rubric stays
unit-testable without a model, a vector store or PyMuPDF.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from claims import EXECUTION, OWNERSHIP, leading_verb, quantitative_claims

WEIGHTS = {"quantification": 40, "action_verbs": 30, "structure": 30}

# Sections whose lines are bullets about work done. The total comes from these
# when there are any, so a summary paragraph or a certificate list can't move it.
SCORED_SECTIONS = ("EXPERIENCE", "PROJECTS", "VOLUNTEER", "LEADERSHIP")

# Lists, citations and prose that the bullet rubric doesn't fit. They show up
# on the heatmap as not graded rather than as a fake 100%.
UNGRADED_SECTIONS = frozenset({
    "HEADER", "SUMMARY", "SKILLS", "LANGUAGES", "INTERESTS", "REFERENCES",
    "CERTIFICATIONS", "PUBLICATIONS",
})

# ------------------------------------------------------------- quantification

# "Python 3" and "React 18" are versions, not results. Only a capitalised word
# after the first one counts as a name, so "Managed 5 engineers" keeps its 5.
_VERSION_RE = re.compile(r'(?<=\s)([A-Z][A-Za-z+#.]*)\s+v?\d+(?:\.\d+)*(?![\w%.])')


def is_quantified(text: str) -> bool:
    """True when the bullet states a figure the candidate can stand behind.

    Placeholders like [X%] and dates are already excluded by ``claims``.
    """
    return bool(quantitative_claims(_VERSION_RE.sub(r'\1', text or '')))


# --------------------------------------------------------------- action verbs

# Participation verbs still describe real work, just less of it than "built".
_MODERATE_VERBS = frozenset({"collaborated", "contributed", "partnered", "facilitated", "supported"})

# Past tenses the ladder in ``claims`` doesn't list and "-ed" can't find.
_IRREGULAR_PAST = frozenset({"ran", "won", "grew", "cut", "made", "taught", "sold", "brought", "began", "set"})

# Present and gerund forms for bullets about a current role ("Lead a team").
_PRESENT_TO_PAST = {
    "lead": "led", "build": "built", "drive": "drove", "write": "wrote", "run": "ran",
    "grow": "grew", "teach": "taught", "sell": "sold", "make": "made", "rebuild": "rebuilt",
}


def _past_forms(word: str) -> list[str]:
    forms = [word]
    stems = [word]
    if word.endswith("ing") and len(word) > 5:
        stems += [word[:-3], word[:-3] + "e"]
    elif word.endswith("es") and len(word) > 4:
        stems += [word[:-2], word[:-1]]
    elif word.endswith("s") and len(word) > 3:
        stems.append(word[:-1])
    for stem in stems:
        forms += [_PRESENT_TO_PAST.get(stem, ""), stem + "ed", stem + "d"]
        if stem.endswith("y"):
            forms.append(stem[:-1] + "ied")
    return [f for f in forms if f]


def action_verb_strength(text: str) -> float:
    """1 for an opener that claims work done, 0.5 for a participation verb, else 0.

    Scored on the original bullet only. A rewrite that turns "helped with X" into
    "led X" never earns this point, because the rewrite is never scored.
    """
    phrase, tier = leading_verb(text)
    if phrase is None:
        return 0.0
    if tier is not None:
        if tier in (EXECUTION, OWNERSHIP):
            return 1.0
        return 0.5 if phrase in _MODERATE_VERBS else 0.0
    if " " in phrase:
        return 0.0
    for form in _past_forms(phrase):
        _form, form_tier = leading_verb(form)
        if form_tier in (EXECUTION, OWNERSHIP):
            return 1.0
    if phrase in _IRREGULAR_PAST:
        return 1.0
    # an unlisted past tense ("Presented", "Negotiated") still claims an action
    if phrase.endswith("ed") and len(phrase) >= 5 and not phrase.endswith("eed"):
        return 1.0
    return 0.0


# ------------------------------------------------------------------ structure

_ABBREVIATION_RE = re.compile(r'\b(?:i\.e|e\.g)\.?|\bi/o\b', re.IGNORECASE)
_FIRST_PERSON_RE = re.compile(
    r"\b(?:i|i'm|i've|i'd|me|my|mine|myself|we|we're|we've|our|ours|ourselves)\b", re.IGNORECASE
)
# "US" is a country, "us" is the candidate
_LOWER_US_RE = re.compile(r'\bus\b')
_FILLER_RE = re.compile(
    r'\b(?:responsible for|duties (?:included|include)|tasked with|in charge of|worked on|'
    r'helped (?:with|to)|assisted (?:with|in)|involved in|various|etc|and so on|a number of)\b',
    re.IGNORECASE,
)


def _length_score(words: int) -> float:
    if 8 <= words <= 30:
        return 1.0
    if 5 <= words <= 40:
        return 0.5
    return 0.0


def structure_checks(text: str) -> dict[str, bool | float]:
    cleaned = _ABBREVIATION_RE.sub(' ', text or '')
    return {
        "length": _length_score(len(cleaned.split())),
        "no_first_person": not (_FIRST_PERSON_RE.search(cleaned) or _LOWER_US_RE.search(cleaned)),
        "no_filler": not _FILLER_RE.search(cleaned),
    }


def structure_score(text: str) -> float:
    checks = structure_checks(text)
    return (checks["length"] + float(checks["no_first_person"]) + float(checks["no_filler"])) / 3


# ------------------------------------------------------------------- combined

def bullet_signals(text: str) -> dict:
    """Every signal for one bullet, plus its own 0-100 score."""
    quantified = is_quantified(text)
    verb = action_verb_strength(text)
    structure = structure_score(text)
    points = (
        WEIGHTS["quantification"] * float(quantified)
        + WEIGHTS["action_verbs"] * verb
        + WEIGHTS["structure"] * structure
    )
    return {
        "quantified": quantified,
        "action_verb": verb,
        "structure": round(structure, 2),
        "score": round(points),
    }


def is_strong(signals: dict) -> bool:
    """Already quantified, action-led and clean: nothing a rewrite should add."""
    return signals["quantified"] and signals["action_verb"] == 1.0 and signals["structure"] == 1.0


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def score_bullets(bullets: Iterable[tuple[str, str]], sections: Iterable[str] = ()) -> dict:
    """Score ``(section, text)`` bullets. ``sections`` lists every section present,
    so a section with nothing gradable still gets a heatmap entry."""
    graded: dict[str, list[dict]] = {}
    for section, text in bullets:
        if section in UNGRADED_SECTIONS:
            continue
        graded.setdefault(section, []).append(bullet_signals(text))

    counted = [s for sec in SCORED_SECTIONS for s in graded.get(sec, [])]
    if not counted:
        counted = [s for items in graded.values() for s in items]

    breakdown = {
        "quantification": round(WEIGHTS["quantification"] * _mean([float(s["quantified"]) for s in counted])),
        "action_verbs": round(WEIGHTS["action_verbs"] * _mean([s["action_verb"] for s in counted])),
        "structure": round(WEIGHTS["structure"] * _mean([s["structure"] for s in counted])),
    }

    section_scores: dict[str, dict] = {}
    for section in list(dict.fromkeys([*sections, *graded])):
        if section == "HEADER":
            continue
        items = graded.get(section, [])
        section_scores[section] = {
            # None, not 100: an ungraded section isn't an excellent one
            "quality": round(_mean([s["score"] for s in items])) if items else None,
            "bullet_count": len(items),
            "quantified": sum(1 for s in items if s["quantified"]),
            "action_verbs": sum(1 for s in items if s["action_verb"] == 1.0),
        }

    return {
        **breakdown,
        "total": sum(breakdown.values()),
        "weights": dict(WEIGHTS),
        "bullets_scored": len(counted),
        "quantified_bullets": sum(1 for s in counted if s["quantified"]),
        "action_verb_bullets": sum(1 for s in counted if s["action_verb"] == 1.0),
        "section_scores": section_scores,
    }
