"""Deterministic claim checks over a rewritten resume bullet.

Two classes of fabrication matter on a CV, and both are decidable without a model:

    quantitative  a number, percentage, amount or count the original never contained
                  ("worked on checkout" -> "improved checkout conversion by 40%")

    qualitative   a claim of more responsibility than the original stated
                  ("helped with the migration" -> "led the migration")

Both are handled here, for free, before any model is consulted. The LLM critic is
then only asked about what genuinely needs judgement, rather than re-deciding a
question that a regex has already answered definitively.

This module deliberately has no heavy imports so the rules stay unit-testable
without ChromaDB, PyMuPDF or a provider SDK on the path.
"""

from __future__ import annotations

import re

_BULLET_PREFIX_RE = re.compile(r'^\s*(?:[-*•‣▪▫◦●]|\d+[.)]|[a-zA-Z][.)])\s+')

# ---------------------------------------------------------------- quantitative

_COUNTED_UNIT = (
    r'users?|people|persons?|clients?|customers?|employees?|members?|students?|'
    r'engineers?|developers?|interns?|stakeholders?|teams?|projects?|services?|'
    r'repos?|repositories|records?|rows?|tickets?|hours?|days?|weeks?|months?|years?'
)

# Ordered longest-first: a counted noun must win over the bare number inside it,
# or "10 users" tokenises as "10" and the unit is lost.
_QUANT_RE = re.compile(
    r'(?<![\w.])('
    r'\$\s?\d[\d,]*(?:\.\d+)?\s*(?:k|m|bn?|thousand|million|billion)?'
    r'|\d[\d,]*(?:\.\d+)?\s*(?:' + _COUNTED_UNIT + r')'
    r'|\d[\d,]*(?:\.\d+)?\s*%'
    r'|\d[\d,]*(?:\.\d+)?\s*(?:k|m|bn?|thousand|million|billion)(?!\w)'
    r'|\d[\d,]*(?:\.\d+)?[xX](?!\w)'
    r'|\d[\d,]*(?:\.\d+)?'
    r')(?!\w)',
    re.IGNORECASE,
)

# A year-like number may be a date ("since 2021") or a quantity ("2000 lines"),
# and only its context tells them apart. Excluding every 1900-2099 number as a
# date silently loses real claims, so the exclusion requires a date context: a
# date preposition immediately before, or an explicit year range on either side.
_YEAR_RE = re.compile(r'(?:19|20)\d{2}')
_DATE_PREPOSITION_RE = re.compile(
    r'\b(?:in|since|from|during|until|till|through|circa|c\.)\s*$', re.IGNORECASE
)
_MONTH_RE = re.compile(
    r'\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$', re.IGNORECASE
)
_RANGE_BEFORE_RE = re.compile(r'(?:19|20)\d{2}\s*(?:to|[-–—])\s*$', re.IGNORECASE)
_RANGE_AFTER_RE = re.compile(r'^\s*(?:to|[-–—])\s*(?:19|20)\d{2}\b', re.IGNORECASE)

# Placeholders are what the rewrite prompt asks for when a metric is missing.
# They are the honest output, so they must never be treated as an invented claim.
_PLACEHOLDER_RE = re.compile(r'\[[^\]]*\]')

_KEY_RE = re.compile(r'^\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(.*)$')
_SCALE_WORDS = {
    'k': 'k', 'thousand': 'k',
    'm': 'm', 'million': 'm',
    'b': 'b', 'bn': 'b', 'billion': 'b',
}


def _claim_key(token: str) -> str:
    """Comparison key for a quantitative token.

    Collapses a counted noun to its magnitude, so rephrasing "10 users" as
    "10 people" is not read as an invented claim, while keeping percentages,
    money, multipliers and scale words distinct from a bare number.
    """
    text = token.lower().replace(',', '').strip()
    match = _KEY_RE.match(text)
    if not match:
        return text
    number, rest = match.group(1), match.group(2).strip()
    if text.startswith('$'):
        scale = _SCALE_WORDS.get(rest, '')
        return f'${number}{scale}'
    if rest.startswith('%'):
        return f'{number}%'
    if rest in ('x',):
        return f'{number}x'
    if rest in _SCALE_WORDS:
        return f'{number}{_SCALE_WORDS[rest]}'
    # Counted noun, or nothing at all: the magnitude is the claim.
    return number


# Spelled-out numbers, used only to widen what the *original* is taken to support.
# Deriving claims from words in the rewrite would misread ordinary prose — "one of
# the services" is not a quantity — so this is applied in one direction only,
# where it can remove a false positive but never create one.
_NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100,
    "dozen": 12,
}
_WORD_NUMBER_RE = re.compile(
    r'\b(' + '|'.join(sorted(_NUMBER_WORDS, key=len, reverse=True)) + r')\b',
    re.IGNORECASE,
)


def _is_date_mention(text: str, start: int, end: int, token: str) -> bool:
    if not _YEAR_RE.fullmatch(token.replace(',', '').strip()):
        return False
    before, after = text[:start], text[end:]
    return bool(
        _DATE_PREPOSITION_RE.search(before)
        or _MONTH_RE.search(before)
        or _RANGE_BEFORE_RE.search(before)
        or _RANGE_AFTER_RE.match(after)
    )


def quantitative_claims(text: str) -> set[str]:
    """Every quantitative token in ``text``, excluding numbers used as dates."""
    without_placeholders = _PLACEHOLDER_RE.sub(' ', text or '')
    found: set[str] = set()
    for match in _QUANT_RE.finditer(without_placeholders):
        token = ' '.join(match.group(1).lower().split())
        if _is_date_mention(without_placeholders, match.start(1), match.end(1), token):
            continue
        found.add(token)
    return found


def _supported_keys(original: str) -> set[str]:
    """Every magnitude the original supports, including spelled-out numbers."""
    keys = {_claim_key(token) for token in quantitative_claims(original)}
    for word in _WORD_NUMBER_RE.findall(original or ''):
        keys.add(str(_NUMBER_WORDS[word.lower()]))
    return keys


def new_quantitative_claims(original: str, rewritten: str) -> set[str]:
    """Quantitative tokens in the rewrite whose magnitude the original lacked."""
    supported = _supported_keys(original)
    return {
        token
        for token in quantitative_claims(rewritten)
        if _claim_key(token) not in supported
    }


def has_new_claims(original: str, rewritten: str) -> bool:
    """True when the rewrite introduces a quantitative claim the original lacked."""
    return bool(new_quantitative_claims(original, rewritten))


# ----------------------------------------------------------------- qualitative

PARTICIPATION = 0
EXECUTION = 1
OWNERSHIP = 2

TIER_NAMES = {
    PARTICIPATION: "participation",
    EXECUTION: "execution",
    OWNERSHIP: "ownership",
}

# Verbs graded by how much responsibility they claim. Moving up a tier is the
# qualitative equivalent of inventing a metric: the bullet now asserts something
# about the candidate's role that the original never said.
_TIERED_VERBS: dict[int, frozenset[str]] = {
    PARTICIPATION: frozenset({
        "aided", "assisted", "attended", "collaborated", "contributed", "helped",
        "joined", "participated", "partnered", "facilitated", "shadowed",
        "supported", "volunteered", "observed", "followed",
    }),
    EXECUTION: frozenset({
        "achieved", "administered", "analysed", "analyzed", "applied", "automated",
        "benchmarked", "built", "compiled", "conducted", "configured", "created",
        "debugged", "delivered", "deployed", "designed", "developed", "documented",
        "enabled", "engineered", "evaluated", "executed", "formulated", "generated",
        "implemented", "improved", "increased", "instrumented", "integrated",
        "investigated", "launched", "maintained", "migrated", "modernised",
        "modernized", "optimised", "optimized", "performed", "ported", "prepared",
        "produced", "programmed", "prototyped", "published", "rebuilt", "redesigned",
        "reduced", "refactored", "researched", "resolved", "rewrote", "scaled",
        "secured", "shipped", "streamlined", "tested", "trained", "transformed",
        "utilised", "utilized", "validated", "wrote",
    }),
    OWNERSHIP: frozenset({
        "architected", "chaired", "championed", "commanded", "coordinated",
        "directed", "drove", "established", "founded", "governed", "headed",
        "initiated", "led", "managed", "mentored", "orchestrated", "oversaw",
        "owned", "pioneered", "spearheaded", "supervised",
    }),
}

_VERB_TIER: dict[str, int] = {
    verb: tier for tier, verbs in _TIERED_VERBS.items() for verb in verbs
}

# Openers that carry a tier but are not a single verb.
_PHRASE_TIER: dict[str, int] = {
    "was responsible for": PARTICIPATION,
    "were responsible for": PARTICIPATION,
    "responsible for": PARTICIPATION,
    "took part in": PARTICIPATION,
    "was part of": PARTICIPATION,
    "part of": PARTICIPATION,
    "member of": PARTICIPATION,
    "involved in": PARTICIPATION,
    "worked on": PARTICIPATION,
    "worked with": PARTICIPATION,
    "assisted with": PARTICIPATION,
    "helped with": PARTICIPATION,
    "in charge of": OWNERSHIP,
    "head of": OWNERSHIP,
    "took ownership of": OWNERSHIP,
    "took the lead on": OWNERSHIP,
}

_WORD_RE = re.compile(r'[a-z]+')


def _normalise(text: str) -> str:
    return ' '.join(_BULLET_PREFIX_RE.sub('', (text or '').strip()).lower().split())


def leading_verb(text: str) -> tuple[str | None, int | None]:
    """The opening verb or phrase of a bullet and the tier it claims.

    Returns ``(None, None)`` when the opener is not a verb this module grades —
    an unknown opener is never treated as evidence in either direction.
    """
    cleaned = _normalise(text)
    if not cleaned:
        return None, None

    for phrase in sorted(_PHRASE_TIER, key=len, reverse=True):
        if cleaned == phrase or cleaned.startswith(phrase + ' '):
            return phrase, _PHRASE_TIER[phrase]

    match = _WORD_RE.search(cleaned)
    if not match:
        return None, None
    word = match.group(0)
    return word, _VERB_TIER.get(word)


def max_tier_in(text: str) -> int:
    """Highest tier claimed anywhere in ``text``; ``-1`` when nothing is graded.

    Used as a guard: "Supported the migration I led" already evidences ownership,
    so rewriting it to open with "Led" is a rephrasing rather than an escalation.
    """
    cleaned = _normalise(text)
    highest = -1
    for phrase, tier in _PHRASE_TIER.items():
        if phrase in cleaned and tier > highest:
            highest = tier
    for word in _WORD_RE.findall(cleaned):
        tier = _VERB_TIER.get(word)
        if tier is not None and tier > highest:
            highest = tier
    return highest


def verb_escalation(original: str, rewritten: str) -> dict | None:
    """Detect a rewrite claiming more responsibility than the original did.

    Returns ``None`` when there is no escalation, otherwise a finding describing
    the move. Deliberately conservative: an ungraded opener on either side, or any
    evidence of the higher tier already present in the original, suppresses the
    finding. A false positive reverts honest work, which is the worse error here.
    """
    from_verb, from_tier = leading_verb(original)
    to_verb, to_tier = leading_verb(rewritten)

    if from_tier is None or to_tier is None:
        return None
    if to_tier <= from_tier:
        return None
    if max_tier_in(original) >= to_tier:
        return None

    return {
        "from": from_verb,
        "to": to_verb,
        "from_tier": TIER_NAMES[from_tier],
        "to_tier": TIER_NAMES[to_tier],
        "detail": (
            f"The original said \"{from_verb}\" ({TIER_NAMES[from_tier]}); "
            f"the rewrite claims \"{to_verb}\" ({TIER_NAMES[to_tier]})."
        ),
    }


# ------------------------------------------------------------------- combined

def findings(original: str, rewritten: str) -> dict:
    """Every deterministic finding for one rewrite, in one call."""
    escalation = verb_escalation(original, rewritten)
    new_claims = new_quantitative_claims(original, rewritten)
    return {
        "new_quantitative_claims": sorted(new_claims),
        "verb_escalation": escalation,
        "clean": not new_claims and escalation is None,
    }
