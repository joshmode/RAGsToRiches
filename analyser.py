from collections.abc import Callable
from typing import Any
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import os
import re
import time
from datetime import date
from dotenv import load_dotenv

from claims import has_new_claims as _has_new_claims
from claims import new_quantitative_claims, verb_escalation
from job_fit import jd_profile, job_fit
from llm_output import parse_json as _parse_json
from prompt_registry import prompt_set_version, prompt_versions, register
from vector_db import query_fw
from parser import ParsedResume
from router import (
    DeadlineExceeded, deadline, default_critic_model, llm_call, record_models, resolve_model,
    submit, time_left,
)
from scoring import action_verb_strength, bullet_signals, is_strong, score_bullets

load_dotenv()

# bullets bundled into one llm call during rewriting
_CHUNK_SIZE = max(1, int(os.environ.get("REWRITE_CHUNK_SIZE", "6")))

# a bullet the rubric already rates as strong is left alone unless this is set
_REWRITE_STRONG_BULLETS = os.environ.get("REWRITE_STRONG_BULLETS", "false").lower() == "true"

# one time budget for a whole analysis, every retry and fallback included
_ANALYSIS_DEADLINE_SECONDS = float(os.environ.get("ANALYSIS_DEADLINE_SECONDS", "240"))

# banned ai jargon that make resumes sound generic
_BANNED_WORDS = (
    "delve, synergy, leverage, utilize, utilise, cutting-edge, innovative, "
    "passion, passionate, dynamic, robust, seamless, holistic, paradigm, "
    "ecosystem, empower, foster, game-changer, best-in-class, world-class, "
    "bleeding-edge, thought leader"
)


def _critic_creds(provider: str, model: str, api_key: str, local_endpoint: str) -> tuple[str, str, str, str]:
    # CRITIC_SAME_AS_MAIN=false by default
    if os.environ.get("CRITIC_SAME_AS_MAIN", "true").lower() == "false":
        provider = os.environ.get("CRITIC_PROVIDER", "openrouter")
        api_key = os.environ.get("CRITIC_API_KEY", "")
        local_endpoint = os.environ.get("CRITIC_LOCAL_ENDPOINT", "")
        model = os.environ.get("CRITIC_MODEL", "")
    elif os.environ.get("CRITIC_MODEL"):
        # same provider/key as the main request
        model = os.environ["CRITIC_MODEL"]
    elif default_critic_model(provider):
        model = default_critic_model(provider)
    return provider, model, api_key, local_endpoint


# The deterministic check has already found the flagged figures. The critic is not
# asked to repeat that search — it is asked whether each one is genuinely
# unsupported, which is the judgement a regex cannot make (a reworded but
# equivalent figure, or a number the original implied).
_NUMERIC_CRITIC_TEMPLATE = register("numeric_critic", (
    "Compare these two text strings for factual consistency.\n"
    "String A (original): {bullet}\n"
    "String B (rewritten): {rewritten}\n"
    "A checker flagged these figures in B as possibly absent from A: {flagged}\n"
    "For each flagged figure, decide whether A genuinely supports it — "
    "whether stated outright, implied, or the same quantity worded differently. "
    "Placeholders like [X%] or [N users] are acceptable and are never a problem. "
    "Reply FAIL if any flagged figure is unsupported by A, otherwise PASS. "
    "Respond with exactly one word: PASS or FAIL followed by a colon and reason."
))


def _run_critic(
    bullet: str,
    rewritten: str,
    result: dict,
    usr_prompt: str,
    sys_prompt: str,
    provider: str,
    local_endpoint: str,
    model: str,
    api_key: str = "",
) -> dict:
    suspect = new_quantitative_claims(bullet, rewritten)
    if not suspect:
        result["critic"] = {"status": "skipped", "reason": "No new quantitative claim detected."}
        return result

    provider, model, api_key, local_endpoint = _critic_creds(provider, model, api_key, local_endpoint)

    try:
        critic_prompt = _NUMERIC_CRITIC_TEMPLATE.format(
            bullet=bullet,
            rewritten=rewritten,
            flagged=", ".join(sorted(suspect)),
        )

        critic_raw = llm_call(
            user_prompt=critic_prompt, provider=provider,
            local_endpoint=local_endpoint, model=model,
            max_tokens=1024, timeout=30, max_retries=1, api_key=api_key,
        )

        if critic_raw.strip().upper().startswith("FAIL"):
            retry_prompt = (
                usr_prompt +
                f"\n\nCRITIC FEEDBACK: {critic_raw.strip()}\n"
                "Please fix the hallucination and ensure no new metrics are invented."
            )
            retry_raw = llm_call(
                user_prompt=retry_prompt, system_prompt=sys_prompt,
                provider=provider, local_endpoint=local_endpoint,
                model=model, max_tokens=1024, timeout=30, max_retries=1, api_key=api_key,
            )
            try:
                parsed_retry = _parse_json(retry_raw)
                if isinstance(parsed_retry, dict):
                    result = parsed_retry
            except Exception:
                pass

            sev = str(result.get("severity", "yellow")).lower()
            if sev not in ("red", "yellow", "green"):
                sev = "yellow"
            result["severity"] = sev
            if _has_new_claims(bullet, result.get("rewritten", bullet)):
                # two passes and it still invents a figure, so fall back to the
                # candidate's own bullet rather than offer a claim nobody can ground
                result["rewritten"] = bullet
                result["reasoning"] = "Withheld: every rewrite of this bullet added figures the original doesn't support."
                result["critic"] = {"status": "failed", "reason": "Corrected rewrite still introduced a new claim."}
            else:
                result["critic"] = {"status": "repaired", "reason": critic_raw.strip()}
        else:
            result["critic"] = {"status": "passed", "reason": critic_raw.strip()}
    except Exception as critic_err:
        # the rewrite stands, but _finalise still flags the figure so the
        # candidate is told it was never checked
        print(f"critic isolated failure, keeping pre-critic result: {critic_err}")
        result["critic"] = {"status": "unavailable", "reason": "The critic couldn't be reached, so this figure wasn't checked."}

    return result


_QUALITATIVE_SYS_PROMPT = register("qualitative_system", (
    "You audit resume rewrites for overstated claims. You are given numbered pairs "
    "of an original bullet and its rewrite. Numeric invention is already checked "
    "elsewhere — ignore it. Judge only whether the rewrite claims something about "
    "the candidate that the original does not support:\n"
    "  role      the rewrite claims more seniority, ownership or leadership\n"
    "  credit    work done by a team or another person is now claimed personally\n"
    "  scope     the rewrite widens the remit, impact or audience\n"
    "  invented  an employer, technology, tool or qualification not in the original\n"
    "Rewording, tightening, reordering and stronger phrasing of the same claim are "
    "all fine and must not be flagged. Only flag a genuine change in what is claimed.\n"
    "Respond with ONLY a JSON array with one object per pair, in the same order:\n"
    '{"index": 0, "verdict": "ok" | "overstated", "kind": "role|credit|scope|invented|none", '
    '"reason": "one short sentence"}'
))


def run_qualitative_critic(
    pairs: list[tuple[str, str]],
    provider: str,
    local_endpoint: str,
    model: str = "",
    api_key: str = "",
) -> list[dict | None]:
    """Audit a batch of rewrites for claims a deterministic check cannot decide.

    The verb ladder in ``claims`` catches the common escalation (an opening verb
    moving up a tier). What it cannot see is mid-sentence escalation, credit
    shifting ("was on the team that shipped X" becoming "shipped X"), scope
    widening, or an invented technology. Those need judgement, so they go to a
    model — but batched, one call per chunk rather than one per bullet, so the
    coverage costs roughly what the old per-bullet gate did.

    Findings are returned for surfacing, never for automatic reversion: unlike the
    numeric path there is no deterministic re-check to make a repair provably safe,
    and silently discarding an otherwise-good rewrite is the worse error.

    Returns a list aligned with ``pairs``; ``None`` means no finding.
    """
    out: list[dict | None] = [None] * len(pairs)
    candidates = [
        (index, original, rewritten)
        for index, (original, rewritten) in enumerate(pairs)
        if rewritten and rewritten.strip() and rewritten.strip() != original.strip()
    ]
    if not candidates:
        return out

    provider, model, api_key, local_endpoint = _critic_creds(provider, model, api_key, local_endpoint)

    block = "\n\n".join(
        f"[{position}]\nORIGINAL: {original}\nREWRITE: {rewritten}"
        for position, (_index, original, rewritten) in enumerate(candidates)
    )
    prompt = (
        f"Audit these {len(candidates)} rewrite pairs.\n\n{block}\n\n"
        f"Return a JSON array of exactly {len(candidates)} objects, one per pair, in order."
    )

    try:
        raw = llm_call(
            user_prompt=prompt, system_prompt=_QUALITATIVE_SYS_PROMPT,
            provider=provider, local_endpoint=local_endpoint, model=model,
            max_tokens=min(4096, 220 * len(candidates)), timeout=45, max_retries=1,
            api_key=api_key,
        )
        parsed = _parse_json(raw)
        if not isinstance(parsed, list) or len(parsed) != len(candidates):
            raise ValueError(
                f"expected {len(candidates)} verdicts, got "
                f"{len(parsed) if isinstance(parsed, list) else type(parsed).__name__}"
            )
        for (index, _original, _rewritten), verdict in zip(candidates, parsed):
            if not isinstance(verdict, dict):
                continue
            if str(verdict.get("verdict", "")).strip().lower() != "overstated":
                continue
            kind = str(verdict.get("kind", "role")).strip().lower()
            if kind not in ("role", "credit", "scope", "invented"):
                kind = "role"
            out[index] = {
                "kind": kind,
                "reason": str(verdict.get("reason", "")).strip()[:300],
            }
    except Exception as err:
        # Isolated failure: the rewrites stand, the audit is simply absent.
        print(f"qualitative critic skipped: {err}")
    return out


_REWRITE_SYS_PROMPT = register("rewrite_system", (
    "You are an expert resume coach. Rewrite weak resume bullets into strong, "
    "ATS-optimised, results-driven statements using the STAR method "
    "(Situation, Task, Action, Result) or Google XYZ framework where applicable. "
    "Write in a grounded, conversational tone — like a competent engineer wrote it, "
    "not a marketing copywriter. "
    "CRITICAL — never invent, assume, or extrapolate any facts: no new metrics, "
    "percentages, team sizes, technologies, employers, or outcomes that are not "
    "explicitly stated in the original bullet. Use placeholders like [X%] or [N users] "
    "when a metric is clearly missing and note it in reasoning. "
    "You MUST apply one of the provided writing frameworks. "
    f"\n\nBANNED WORDS (never use these): {_BANNED_WORDS}\n"
    "Always respond with valid JSON only, no markdown."
))

_RESULT_SCHEMA = register("result_schema", (
    "{\n"
    '  "rewritten": "the improved bullet point",\n'
    '  "reasoning": "one sentence: what was weak, what framework was applied, what changed",\n'
    '  "framework_used": "Google XYZ | STAR | Rule of 3 | Action Verb | other",\n'
    '  "severity": "red | yellow | green"\n'
    "}"
))

_SEVERITY_GUIDE = register("severity_guide", (
    "Severity guide — rate the ORIGINAL bullet, not the rewrite: "
    "red = very weak passive language, missing action verb, or no discernible impact. "
    "yellow = structurally okay but missing a metric or could be stronger. "
    "green = already strong; only minor polish applied."
))

_BATCH_INDEX_RULE = register("batch_index_rule", (
    'Every object must also include "index": the number shown in brackets before '
    "the bullet it rewrites."
))


def _build_rewrite_prompts(bullet: str, frameworks: list[Any]) -> tuple[str, str]:
    fw_ctx = "\n\n".join(f.document for f in frameworks)

    usr_prompt = (
        f"FRAMEWORK GUIDANCE (apply the most relevant one):\n{fw_ctx}\n\n"
        f"BULLET TO REWRITE:\n{bullet}\n\n"
        f"Respond with this exact JSON structure:\n{_RESULT_SCHEMA}\n"
        f"{_SEVERITY_GUIDE}"
    )
    return _REWRITE_SYS_PROMPT, usr_prompt


def _normalise_severity(result: dict) -> dict:
    sev = str(result.get("severity", "yellow")).lower()
    if sev not in ("red", "yellow", "green"):
        sev = "yellow"
    result["severity"] = sev
    return result


def _finalise(result: dict, original: str) -> dict:
    """Stamp the source bullet on a rewrite and attach deterministic findings.

    Both checks are free, so they run on every rewrite whether or not the
    critic is switched on. A role escalation ("helped with X" rewritten as
    "led X") or a figure the original never stated is surfaced rather than
    reverted. The rest of the rewrite is usually fine, and the candidate
    already accepts or rejects each suggestion individually — so the honest move
    is to tell them what the model changed and let them decide, not to silently
    discard work. The score only reads the original bullet, so neither can
    ever be rewarded.
    """
    result["original"] = original
    _normalise_severity(result)
    rewritten = result.get("rewritten") or original
    escalation = verb_escalation(original, rewritten)
    if escalation:
        result["verb_escalation"] = escalation
    else:
        result.pop("verb_escalation", None)
    new_claims = sorted(new_quantitative_claims(original, rewritten))
    if new_claims:
        result["new_claims"] = new_claims
    else:
        result.pop("new_claims", None)
    return result


def rewrite_item(
    bullet: str,
    frameworks: list[Any],
    provider: str,
    local_endpoint: str,
    use_critic: bool = False,
    model: str = "",
    api_key: str = "",
) -> dict:
    sys_prompt, usr_prompt = _build_rewrite_prompts(bullet, frameworks)

    try:
        raw = llm_call(user_prompt=usr_prompt, system_prompt=sys_prompt,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=1024, api_key=api_key)
        result = _normalise_severity(_parse_json(raw))

        if use_critic:
            result = _run_critic(
                bullet, result.get("rewritten", bullet), result,
                usr_prompt, sys_prompt, provider, local_endpoint, model, api_key=api_key,
            )

        return _finalise(result, bullet)

    except Exception as e:
        print(f"bullet rewrite bypassed: {e}")
        return _skipped(bullet, e)


def _skipped(bullet: str, err: Exception) -> dict:
    reason = (
        "Rewrite skipped: the analysis ran out of time." if isinstance(err, DeadlineExceeded)
        else "Rewrite skipped: the model didn't return a usable answer."
    )
    return {
        "original":       bullet,
        "rewritten":      bullet,
        "reasoning":      reason,
        "framework_used": "error",
        "severity":       "red"
    }


_ALIGN_WORD_RE = re.compile(r'[a-z0-9][a-z0-9+#.]*')
_ALIGN_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "into", "using", "used",
    "was", "were", "our", "their", "its", "across", "over", "per",
}


def _content_words(text: str) -> set[str]:
    return {w for w in _ALIGN_WORD_RE.findall((text or "").lower()) if len(w) >= 3 and w not in _ALIGN_STOPWORDS}


def _align_batch(originals: list[str], parsed: Any) -> list[dict]:
    """Put a batch response back in bullet order, or raise if it can't be trusted.

    Matching by position alone put a swapped answer on the wrong bullet. The model
    echoes each bullet's index, and a rewrite that shares more of another bullet's
    words than its own is treated as misplaced whatever index it came back with.
    """
    count = len(originals)
    if not isinstance(parsed, list) or len(parsed) != count:
        got = len(parsed) if isinstance(parsed, list) else type(parsed).__name__
        raise ValueError(f"expected {count} rewrites in response, got {got}")
    if not all(isinstance(item, dict) for item in parsed):
        raise ValueError("chunk response item was not a JSON object")

    indexes: list[int | None] = []
    for item in parsed:
        try:
            indexes.append(int(item["index"]))
        except (KeyError, TypeError, ValueError):
            indexes.append(None)

    if all(index is None for index in indexes):
        ordered = list(parsed)
    elif None in indexes:
        raise ValueError("some rewrites in the batch came back without an index")
    else:
        # some models count from 1 however the bullets are numbered
        if sorted(indexes) == list(range(1, count + 1)):
            indexes = [index - 1 for index in indexes]
        if sorted(indexes) != list(range(count)):
            raise ValueError(f"batch indexes {indexes} don't cover bullets 0..{count - 1}")
        ordered = [item for _index, item in sorted(zip(indexes, parsed), key=lambda pair: pair[0])]

    words = [_content_words(text) for text in originals]
    for i, item in enumerate(ordered):
        rewritten = _content_words(str(item.get("rewritten", "")))
        own = len(rewritten & words[i]) / max(1, len(words[i]))
        for j, other in enumerate(words):
            if j != i and len(rewritten & other) / max(1, len(other)) > max(own, 0.3):
                raise ValueError(f"rewrite {i} reads like bullet {j}")
    return ordered


def _rewrite_each(
    items: list[tuple[str, list[Any]]],
    provider: str,
    local_endpoint: str,
    use_critic: bool,
    model: str,
    api_key: str,
) -> list[dict]:
    """One call per bullet, side by side. The provider semaphore still caps them."""
    with ThreadPoolExecutor(max_workers=min(4, len(items))) as pool:
        futures = [
            submit(pool, rewrite_item, text, fws, provider, local_endpoint, use_critic, model=model, api_key=api_key)
            for text, fws in items
        ]
        return [future.result() for future in futures]


def rewrite_chunk(
    items: list[tuple[str, list[Any]]],
    provider: str,
    local_endpoint: str,
    use_critic: bool = False,
    model: str = "",
    api_key: str = "",
) -> list[dict]:
    if not items:
        return []
    if len(items) == 1:
        text, fws = items[0]
        return [rewrite_item(text, fws, provider, local_endpoint, use_critic, model=model, api_key=api_key)]

    # each guide once, numbered, and each bullet names the guides retrieved for it.
    # merging them into one pool lost the per-bullet grounding the retrieval is for
    guides: dict[str, str] = {}
    for _text, fws in items:
        for f in fws:
            guides.setdefault(f.document, f"F{len(guides) + 1}")
    fw_ctx = "\n\n".join(f"[{label}] {document}" for document, label in guides.items()) or "none"

    bullets_block = "\n\n".join(
        f"[{i}] (guides: {', '.join(guides[f.document] for f in fws) or 'none'}) {text}"
        for i, (text, fws) in enumerate(items)
    )

    usr_prompt = (
        f"FRAMEWORK GUIDANCE (apply the most relevant of the guides listed with each bullet):\n{fw_ctx}\n\n"
        f"BULLETS TO REWRITE — {len(items)} independent bullets, numbered in order. "
        f"Rewrite EVERY one, keep the same order, do not merge or skip any:\n{bullets_block}\n\n"
        f"Respond with ONLY a JSON array of exactly {len(items)} objects, one per bullet "
        f"in the same order as the input, each with this exact structure:\n{_RESULT_SCHEMA}\n"
        f"{_BATCH_INDEX_RULE}\n"
        f"{_SEVERITY_GUIDE}"
    )

    try:
        raw = llm_call(user_prompt=usr_prompt, system_prompt=_REWRITE_SYS_PROMPT,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=min(8192, 500 * len(items)), api_key=api_key)
        ordered = _align_batch([text for text, _fws in items], _parse_json(raw))
        results = []
        for (text, _fws), item_result in zip(items, ordered):
            item_result = dict(item_result)
            item_result.pop("index", None)
            results.append(_finalise(item_result, text))

    except Exception as e:
        left = time_left()
        if isinstance(e, DeadlineExceeded) or (left is not None and left < 5):
            # one call per bullet would only fail the same way, and slower
            print(f"chunk rewrite ran out of time ({len(items)} bullets): {e}")
            return [_skipped(text, DeadlineExceeded()) for text, _fws in items]
        print(f"chunk rewrite failed ({len(items)} bullets), falling back to per-bullet calls: {e}")
        return _rewrite_each(items, provider, local_endpoint, use_critic, model, api_key)

    if use_critic:
        for i, (text, fws) in enumerate(items):
            sys_prompt, usr_prompt_single = _build_rewrite_prompts(text, fws)
            results[i] = _run_critic(
                text, results[i].get("rewritten", text), results[i],
                usr_prompt_single, sys_prompt, provider, local_endpoint, model, api_key=api_key,
            )
            results[i] = _finalise(results[i], text)

        # One batched pass for the claims a regex cannot decide. Runs after the
        # numeric loop so it audits the text that actually survived it.
        audits = run_qualitative_critic(
            [(text, results[i].get("rewritten", text)) for i, (text, _fws) in enumerate(items)],
            provider, local_endpoint, model=model, api_key=api_key,
        )
        for i, audit in enumerate(audits):
            if audit:
                results[i]["overstated"] = audit

    return results


_BULLET_PREFIX_RE = re.compile(r'^\s*(?:[-*•‣▪▫◦●]|\d+[.)]|[a-zA-Z][.)])\s+')
_DATE_RE = re.compile(r'\b(?:19|20)\d{2}\b|\b(?:present|current)\b', re.IGNORECASE)
_DATE_RANGE_RE = re.compile(
    r'\b(?:19|20)\d{2}\s*(?:[-–—]|to)\s*(?:(?:19|20)\d{2}|present|current)\b',
    re.IGNORECASE,
)
_JOB_TITLE_RE = re.compile(
    r'^[A-Z][A-Za-z\s,/&]+'
    r'(?:[,|–—\-]\s*[A-Z][A-Za-z\s,&.]+)*'
    r'\s*[,|–—\-]?\s*'
    r'(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+)?'
    r'(?:19|20)\d{2}',
    re.IGNORECASE,
)
_ACTION_VERBS = {
    "achieved", "administered", "analysed", "analyzed", "automated", "built", "collaborated",
    "conducted", "created", "delivered", "designed", "developed", "drove", "enabled",
    "engineered", "executed", "improved", "increased", "launched", "led", "managed",
    "investigated", "optimised", "optimized", "owned", "partnered", "prepared", "reduced",
    "resolved", "shipped", "streamlined", "supported", "trained", "transformed",
    "implemented", "utilised", "utilized", "spearheaded", "directed", "orchestrated",
    "programmed", "architected", "mentored", "published", "researched", "formulated",
    "integrated", "migrated", "debugged", "facilitated", "generated", "coordinated",
    "evaluated", "benchmarked", "prototyped",
}


def _strip_prefix(line: str) -> tuple[str, bool]:
    stripped = re.sub(r'\s+', ' ', line).strip()
    m = _BULLET_PREFIX_RE.match(stripped)
    if not m:
        return stripped, False
    return stripped[m.end():].strip(), True


def _sent_complete(text: str) -> bool:
    return bool(re.search(r'[.!?]\s*$', text.strip()))


def _first_word(text: str) -> str:
    m = re.match(r'^[^\w]*([A-Za-z]+)', text.strip())
    return m.group(1).lower() if m else ""


def _is_header(line: str, section: str = "") -> bool:
    cleaned, has_bullet = _strip_prefix(line)
    if has_bullet:
        return False

    words = cleaned.split()
    wc = len(words)
    if wc == 0:
        return True

    if wc <= 3 and cleaned.endswith(":"):
        return True

    relaxed = ("PROJECTS", "EDUCATION", "SKILLS", "CERTIFICATIONS", "AWARDS", "VOLUNTEER")
    if section not in relaxed and wc <= 4 and not _sent_complete(cleaned):
        return True

    has_range = bool(_DATE_RANGE_RE.search(cleaned))
    has_date = bool(_DATE_RE.search(cleaned))

    if has_range and wc <= 20 and not _sent_complete(cleaned):
        return True
    if has_date and wc <= 14 and not _sent_complete(cleaned):
        return True

    if _JOB_TITLE_RE.match(cleaned) and not _sent_complete(cleaned):
        return True

    #Skills lists are almost entirely nouns. Bypassing this stops them from being thrown out
    if section == "SKILLS":
        return False

    # for proj lines that look like project name headers but contain tech stack indicators are treated as subheaders
    if section == "PROJECTS":
        has_pipe = "|" in cleaned or "–" in cleaned or "—" in cleaned
        starts_action = _first_word(cleaned) in _ACTION_VERBS
        if has_pipe and wc <= 12 and not starts_action:
            return True
        # very short lines without action verbs are project name headers
        if wc <= 5 and not starts_action and not _sent_complete(cleaned):
            title_words = sum(1 for w in words if w[:1].isupper() or w.isupper())
            if title_words / max(wc, 1) >= 0.6:
                return True
        return False

    title_words = sum(1 for w in words if w[:1].isupper() or w.isupper())
    title_ratio = title_words / max(wc, 1)
    starts_action = _first_word(cleaned) in _ACTION_VERBS

    if title_ratio >= 0.75 and wc <= 14 and not starts_action and not _sent_complete(cleaned):
        return True

    return False


def _is_candidate(line: str, has_bullet: bool = False, section: str = "") -> bool:
    cleaned, marker = _strip_prefix(line)
    has_bullet = has_bullet or marker
    words = cleaned.split()
    if _is_header(line, section=section):
        return False

    relaxed = ("EXPERIENCE", "PROJECTS", "VOLUNTEER", "SUMMARY", "SKILLS", "EDUCATION")
    min_chars = 20 if section in relaxed else 35
    min_words = 3 if section in relaxed else 6

    if len(cleaned) < min_chars or len(words) < min_words:
        return False

    if re.search(r'@|linkedin\.com|github\.com|https?://', cleaned, re.IGNORECASE):
        return False

    starts_action = _first_word(cleaned) in _ACTION_VERBS
    if section == "PROJECTS" and starts_action:
        return True

    return has_bullet or len(words) >= (3 if section in relaxed else 7)


def _looks_like_bullet(line: str) -> bool:
    return _is_candidate(line)


def _make_id(sec: str, idxs: list[int], text: str) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
    first = idxs[0] if idxs else 0
    return f"{sec}:{first}:{digest}"


def _flush_unit(
    units: list[dict[str, Any]],
    sec: str,
    buf: list[tuple[int, str]],
    eligible: bool,
) -> None:
    if not buf:
        return
    idxs = [i for i, _ in buf]
    text = " ".join(_strip_prefix(line)[0] for _, line in buf)
    text = re.sub(r'\s+', ' ', text).strip()
    units.append({
        "id": _make_id(sec, idxs, text),
        "text": text,
        "line_indices": idxs,
        "eligible": eligible and _is_candidate(text, section=sec),
    })


def _build_units(sec: str, lines: list[str]) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    buf: list[tuple[int, str]] = []
    buf_ok = False

    for idx, line in enumerate(lines):
        cleaned, has_bullet = _strip_prefix(line)
        if not cleaned:
            continue

        header = _is_header(line, section=sec)
        cand = _is_candidate(line, has_bullet=has_bullet, section=sec)
        if header:
            _flush_unit(units, sec, buf, buf_ok)
            _flush_unit(units, sec, [(idx, line)], False)
            buf = []
            buf_ok = False
            continue

        # start new unit after a complete sentence
        buf_text = " ".join(part for _, part in buf) if buf else ""
        buf_done = _sent_complete(buf_text)
        new_unit = (has_bullet or not buf or (buf_done and cand))

        if new_unit:
            _flush_unit(units, sec, buf, buf_ok)
            buf = [(idx, line)]
            buf_ok = cand and not header
        else:
            buf.append((idx, line))
            buf_ok = buf_ok or cand

    _flush_unit(units, sec, buf, buf_ok)
    return units


_PRIMARY_SECTIONS = ("EXPERIENCE", "PROJECTS", "VOLUNTEER", "SUMMARY")

# lists and citations. an XYZ rewrite of "Python, Go, SQL" is wasted tokens at best
_LIST_SECTIONS = frozenset({"SKILLS", "LANGUAGES", "INTERESTS", "REFERENCES", "CERTIFICATIONS", "PUBLICATIONS"})


def _looks_like_list(text: str) -> bool:
    """"Python, Go, SQL" or "Coursework: Algorithms, Databases, Networks", not a sentence"""
    body = text.split(":", 1)[1] if ":" in text[:40] else text
    parts = [part.strip() for part in re.split(r'[,;|•·]', body) if part.strip()]
    if len(parts) < 3:
        return False
    return sum(len(part.split()) for part in parts) / len(parts) <= 3 and action_verb_strength(text) == 0


def _plan_units(resume: ParsedResume) -> list[tuple[str, int, dict[str, Any]]]:
    """Every unit the pipeline looks at, with its final eligibility.

    Shared by the score and the rewrite loop so both see the same bullets.
    """
    jobs: list[tuple[str, int, dict[str, Any]]] = []

    for sec in _PRIMARY_SECTIONS:
        lines = resume.sections.get(sec, [])
        if not lines:
            continue
        for i, unit in enumerate(_build_units(sec, lines)):
            text = unit["text"]
            unit["eligible"] = unit["eligible"] and not _is_header(text, section=sec) and not _looks_like_list(text)
            jobs.append((sec, i, unit))

    # everything else the parser found. this was a fixed whitelist once and it kept drifting out
    for sec, lines in resume.sections.items():
        if sec == "HEADER" or sec in _PRIMARY_SECTIONS or not lines:
            continue
        for i, unit in enumerate(_build_units(sec, lines)):
            text = unit["text"]
            words = text.split()
            unit["eligible"] = (
                sec not in _LIST_SECTIONS
                and (unit["eligible"] or len(words) >= 4)
                and not _is_header(text, section=sec)
                and not _looks_like_list(text)
            )
            jobs.append((sec, i, unit))

    return jobs


def calc_score(resume: ParsedResume, rewrites: dict[str, list[dict]] | None = None) -> dict:
    """Score the resume from its own bullets (see ``scoring``).

    ``rewrites`` is only read for the escalation count, which is a diagnostic:
    the rewrite text never reaches the score, so an escalated verb can't earn
    anything.
    """
    bullets = [(sec, unit["text"]) for sec, _i, unit in _plan_units(resume) if unit["eligible"]]
    score = score_bullets(bullets, sections=resume.sections.keys())
    score["verb_escalations"] = sum(
        1 for items in (rewrites or {}).values() for item in items if item.get("verb_escalation")
    )
    return score


def analyse(
    resume: ParsedResume,
    job_description: str,
    provider: str = "gemini",
    local_endpoint: str = "",
    use_critic: bool = False,
    model: str = "",
    api_key: str = "",
    progress: Callable[[dict], None] | None = None,
) -> dict:
    """Analyse a resume against a job description.

    ``progress`` receives stage events as the pipeline advances. It is optional
    and purely additive: the returned value is identical whether or not it is
    supplied, so the existing request/response path is unaffected. Events are
    emitted from the collecting thread, never from a worker, so the callback does
    not need to be thread-safe.

    Every model call inside runs against one deadline (ANALYSIS_DEADLINE_SECONDS),
    so retries and fallbacks can't stack past what the client waits for.
    """
    with deadline(_ANALYSIS_DEADLINE_SECONDS), record_models() as used:
        result = _run_analysis(resume, job_description, provider, local_endpoint, use_critic, model, api_key, progress)
    # what answered, not just what was asked for: a fallback model is named too
    result["model"] = ", ".join(sorted(used)) or resolve_model(provider, model)
    return result


def _run_analysis(
    resume: ParsedResume,
    job_description: str,
    provider: str,
    local_endpoint: str,
    use_critic: bool,
    model: str,
    api_key: str,
    progress: Callable[[dict], None] | None,
) -> dict:
    def emit(stage: str, **fields: Any) -> None:
        if progress is None:
            return
        try:
            progress({"stage": stage, **fields})
        except Exception as progress_err:
            # A broken consumer must not take the analysis down with it.
            print(f"progress callback failed: {progress_err}")

    t_start = time.perf_counter()
    emit("started")

    # the one read of the job description runs alongside everything else. the
    # rewrites don't wait for it any more, they never needed its keywords
    def _read_jd():
        started = time.perf_counter()
        profile = jd_profile(job_description, provider, local_endpoint, model=model, api_key=api_key)
        return profile, time.perf_counter() - started

    jd_pool = ThreadPoolExecutor(max_workers=1)
    jd_future = submit(jd_pool, _read_jd) if job_description.strip() else None
    jd_read: dict = {}
    jd_failed = False
    t_kw = 0.0
    jd_joined = False

    def join_jd(block: bool) -> None:
        nonlocal jd_read, jd_failed, t_kw, jd_joined
        if jd_joined or (jd_future is not None and not block and not jd_future.done()):
            return
        jd_joined = True
        if jd_future is not None:
            try:
                jd_read, t_kw = jd_future.result()
            except Exception as kw_err:
                print(f"job description read failed: {kw_err}")
                jd_failed = True
        emit("keywords", found=len(jd_read.get("keywords", [])), failed=jd_failed)

    rewrites: dict[str, list[dict]] = {}

    jobs = _plan_units(resume)

    # quantified, action-led and clean already: a rewrite has nothing to add
    strong: dict[str, dict] = {}
    for _sec, _i, unit in jobs:
        if unit["eligible"] and not _REWRITE_STRONG_BULLETS:
            signals = bullet_signals(unit["text"])
            if is_strong(signals):
                strong[unit["id"]] = signals

    emit("planned", bullets=len(jobs))

    t_retrieval = time.perf_counter()
    fw_cache_local: dict[str, list] = {}
    retrieval_failed = False
    for sec, i, unit in jobs:
        text = unit["text"]
        if unit["eligible"] and unit["id"] not in strong:
            if text not in fw_cache_local:
                # guidance improves a rewrite but isn't needed for one, so a broken
                # vector store costs the grounding, not the whole analysis
                try:
                    fw_cache_local[text] = [] if retrieval_failed else query_fw(text, n_results=3)
                except Exception as fw_err:
                    print(f"framework retrieval failed, rewriting without guidance: {fw_err}")
                    retrieval_failed = True
                    fw_cache_local[text] = []
    t_retrieval = time.perf_counter() - t_retrieval
    emit("retrieved", retrieval_ms=int(t_retrieval * 1000), failed=retrieval_failed)
    join_jd(block=False)

    def _label_rw(sec, unit):
        text = unit["text"]
        rw = {
            "original": text, "rewritten": text,
            "reasoning": "Header or label line — no rewrite needed.",
            "framework_used": "none",
        }
        rw["id"] = unit["id"]
        rw["section"] = sec
        rw["line_indices"] = unit["line_indices"]
        rw["highlight_text"] = text
        return rw

    def _strong_rw(sec, unit):
        rw = _label_rw(sec, unit)
        rw["reasoning"] = "Already strong: it has a figure, opens with an action verb and reads cleanly."
        rw["strong"] = True
        rw["signals"] = strong[unit["id"]]
        return rw

    results_by_sec: dict[str, list[tuple[int, dict]]] = {}
    eligible_jobs: list[tuple[str, int, dict]] = []
    for sec, i, unit in jobs:
        if unit["id"] in strong:
            results_by_sec.setdefault(sec, []).append((i, _strong_rw(sec, unit)))
        elif unit["eligible"]:
            eligible_jobs.append((sec, i, unit))
        else:
            results_by_sec.setdefault(sec, []).append((i, _label_rw(sec, unit)))

    # bundle bullets into chunks so one llm call rewrites several at once
    chunks = [eligible_jobs[k:k + _CHUNK_SIZE] for k in range(0, len(eligible_jobs), _CHUNK_SIZE)]

    def _do_chunk(chunk_jobs):
        items = [(unit["text"], fw_cache_local[unit["text"]]) for _sec, _i, unit in chunk_jobs]
        chunk_results = rewrite_chunk(items, provider, local_endpoint, use_critic, model=model, api_key=api_key)
        out = []
        for (sec, i, unit), rw in zip(chunk_jobs, chunk_results):
            rw = dict(rw)
            rw["id"] = unit["id"]
            rw["section"] = sec
            rw["line_indices"] = unit["line_indices"]
            rw["highlight_text"] = unit["text"]
            # what the score saw in the original, so the UI can say why
            rw["signals"] = bullet_signals(unit["text"])
            out.append((sec, i, rw))
        return out

    workers = min(3 if use_critic else 8, max(len(chunks), 1))
    completed = 0
    emit("rewriting", chunks=len(chunks), bullets=len(eligible_jobs), workers=workers)
    t_rewrite = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {submit(pool, _do_chunk, chunk): idx for idx, chunk in enumerate(chunks)}
        for fut in as_completed(futures):
            chunk_idx = futures[fut]
            try:
                chunk_out = fut.result()
            except Exception as thread_err:
                print(f"chunk rewrite thread failed: {thread_err}")
                chunk_out = []
                for sec, i, unit in chunks[chunk_idx]:
                    rw = {
                        "original": unit["text"], "rewritten": unit["text"],
                        "reasoning": "Rewrite skipped due to processing error.",
                        "framework_used": "error",
                        "id": unit["id"], "section": sec,
                        "line_indices": unit["line_indices"],
                        "highlight_text": unit["text"],
                    }
                    chunk_out.append((sec, i, rw))
            for sec, i, rw in chunk_out:
                results_by_sec.setdefault(sec, []).append((i, rw))
            completed += 1
            emit(
                "chunk",
                completed=completed,
                total=len(chunks),
                rewrites=[rw for _sec, _i, rw in chunk_out],
            )
            join_jd(block=False)
    t_rewrite = time.perf_counter() - t_rewrite
    join_jd(block=True)
    jd_pool.shutdown(wait=False)

    for sec, items in results_by_sec.items():
        items.sort(key=lambda x: x[0])
        rewrites[sec] = [rw for _, rw in items]

    score = calc_score(resume, rewrites)
    fit = job_fit(resume.raw_text, jd_read)
    t_total = time.perf_counter() - t_start
    critic_counts: dict[str, int] = {}
    guard_counts = {"verb_escalation": 0, "overstated": 0, "new_claims": 0, "withheld": 0}
    for section in rewrites.values():
        for item in section:
            status = item.get("critic", {}).get("status")
            if status:
                critic_counts[status] = critic_counts.get(status, 0) + 1
            if item.get("verb_escalation"):
                guard_counts["verb_escalation"] += 1
            if item.get("overstated"):
                guard_counts["overstated"] += 1
            # a figure the critic checked and passed isn't an open question
            if item.get("new_claims") and status != "passed":
                guard_counts["new_claims"] += 1
            if status == "failed" and item.get("rewritten") == item.get("original"):
                guard_counts["withheld"] += 1

    emit("scored", score=score.get("total", 0))

    return {
        "contact":             resume.contact,
        "sections":            resume.sections,
        "rewrites":            rewrites,
        # jd_keywords, missing_keywords, strong_matches, keyword_frequencies,
        # match_pct, company and tailoring_tips, all from the one read
        **fit,
        "keyword_extraction_failed": jd_failed,
        "retrieval_failed":    retrieval_failed,
        "score":               score,
        "warnings":            resume.warnings,
        "ocr_used":            resume.ocr_used,
        # "no jd" and "extraction failed" have to stay distinct
        "no_jd_provided":      not job_description.strip(),
        "timing": {
            "keywords_ms":   int(t_kw * 1000),
            "retrieval_ms":  int(t_retrieval * 1000),
            "rewriting_ms":  int(t_rewrite * 1000),
            "total_ms":      int(t_total * 1000),
        },
        "critic":              critic_counts,
        "claim_guard":         guard_counts,
        "already_strong":      len(strong),
        "rewrite_skipped":     sum(
            1 for items in rewrites.values() for item in items if item.get("framework_used") == "error"
        ),
        "prompt_versions":     prompt_versions(),
        "prompt_set_version":  prompt_set_version(),
    }


def _apply_rewrites(
    sec: str,
    lines: list[str],
    acc_map: dict,
    suggestions: dict[str, list[dict]] | None,
    decisions: dict[str, bool] | None,
    mentor_overrides: dict[str, str] | None = None,
) -> tuple[list[str], list[dict], list[dict]]:
    mentor_overrides = mentor_overrides or {}
    decisions = decisions or {}
    # a mentor's edit can be accepted without ever going through the suggestions flow
    if not suggestions or (not decisions and not mentor_overrides):
        return [acc_map.get(line, line) for line in lines], [], []

    by_first = {
        item["line_indices"][0]: item
        for item in suggestions.get(sec, [])
        if item.get("line_indices")
        and item.get("framework_used") not in ("none", "error")
    }

    out: list[str] = []
    accepted: list[dict] = []
    dismissed: list[dict] = []
    skip_until = -1

    for idx, line in enumerate(lines):
        if idx <= skip_until:
            continue

        item = by_first.get(idx)
        decision = decisions.get(item.get("id")) if item else None
        # an accepted mentor rewrite wins whatever was done with the llm's own suggestion
        override = mentor_overrides.get(item.get("id")) if item else None
        if item and override:
            out.append(override)
            accepted.append(item)
            skip_until = max(item.get("line_indices", [idx]))
        elif item and decision is True:
            out.append(item.get("rewritten", item.get("original", line)))
            accepted.append(item)
            skip_until = max(item.get("line_indices", [idx]))
        elif item and decision is False:
            out.append(item.get("original", line))
            dismissed.append(item)
            skip_until = max(item.get("line_indices", [idx]))
        else:
            out.append(acc_map.get(line, line))

    return out, accepted, dismissed


def gen_cv(
    resume: ParsedResume,
    job_description: str,
    acc_map: dict,
    provider: str,
    local_endpoint: str,
    rewrite_suggestions: dict[str, list[dict]] | None = None,
    rewrite_decisions: dict[str, bool] | None = None,
    model: str = "",
    api_key: str = "",
    mentor_overrides: dict[str, str] | None = None,
    section_overrides: dict[str, str] | None = None,
) -> str:
    """generate a tailored CV from resume data and accepted rewrites.

    mentor_overrides maps a rewrite suggestion's id to text a mentor suggested and the
    candidate has already accepted - that wins over the LLM's own rewrite for that bullet.

    section_overrides maps a SECTION NAME to a mentor-rewritten replacement for the whole
    section, once the candidate has accepted that mentor Section Edit. It takes precedence
    over every bullet-level mechanism above (rewrite_decisions, mentor_overrides) for that
    section - the mentor's rewritten section becomes that section's sole source of truth,
    and per-bullet AI rewrites for it are never applied again."""
    has_jd = bool(job_description.strip())
    section_overrides = section_overrides or {}

    # build resume text with only accepted rewrites
    cv_text = ""
    acc_items: list[dict] = []
    dis_items: list[dict] = []

    if resume.contact:
        cv_text += "=== CONTACT ===\n"
        for k, v in resume.contact.items():
            cv_text += f"{k}: {v}\n"

    for sec, lines in resume.sections.items():
        # HEADER is the parser's bucket for stray intro lines
        if sec != "HEADER":
            cv_text += f"\n=== {sec} ===\n"
        if sec in section_overrides:
            for line in section_overrides[sec].splitlines():
                if line.strip():
                    cv_text += line + "\n"
            continue
        applied, acc_sec, dis_sec = _apply_rewrites(sec, lines, acc_map, rewrite_suggestions, rewrite_decisions, mentor_overrides)
        acc_items.extend(acc_sec)
        dis_items.extend(dis_sec)
        for line in applied:
            cv_text += line + "\n"

    # cv_text already has decisions applied
    section_names = [sec for sec in resume.sections.keys() if sec != "HEADER"]
    section_list = ", ".join(section_names) if section_names else "the sections present in the resume"

    sys_prompt = (
        "You are an expert CV formatter and editor. Reformat the candidate's resume into a "
        "professional, ATS-friendly CV in Markdown. The resume text you receive is FINAL: "
        "every bullet already reflects the candidate's accepted wording decisions. "
        "Preserve the meaning and content of every bullet — you may tighten grammar and phrasing, "
        "but never drop a role, project, qualification, or section, and never re-order facts between roles. "
        "Never invent employers, dates, credentials, projects, metrics, or skills not present in the resume. "
        "Write in a grounded, professional tone. Avoid corporate fluff. "
        f"\n\nBANNED WORDS (never use these): {_BANNED_WORDS}\n"
        "\nFORMATTING RULES — follow these exactly:\n"
        "1. Output ONLY the final CV in Markdown format, nothing else.\n"
        f"2. Include EVERY one of these sections, each with all of its content: {section_list}. "
        "Do not omit or merge any of them. If content is long, keep it — a 2-page CV is fine.\n"
        "3. Start with the candidate's name as # Name.\n"
        "4. Contact details on a single line separated by ` | `.\n"
        "5. Each section: ## SECTION NAME in ALL CAPS, followed by `---`.\n"
        "6. Job/project titles as ### or **_Title_**, dates on the same line after `|`.\n"
        "7. Bullets start with a strong ATS action verb in past tense where the original does.\n"
        "8. Keep every single bullet from the source resume, in the same order, one output bullet "
        "per source bullet. Do not drop, merge, or skip any bullet for any reason, including ones "
        "that look redundant or weak - the candidate already decided which wording to keep for "
        "every bullet, and that decision must be preserved exactly.\n"
        "9. Section order: Summary first (if present), then Experience, Education, Skills, "
        "Projects, then all remaining sections in their original order. Every section listed "
        "in rule 2 MUST appear.\n"
        "10. No preamble, no explanation — CV text only."
    )

    jd_block = (
        f"JOB DESCRIPTION (for emphasis and keyword alignment only — do not fabricate skills to match it):\n{job_description}\n\n" if has_jd
        else "JOB DESCRIPTION:\nNone provided. Optimise for clarity, impact, and ATS readability.\n\n"
    )
    usr_prompt = (
        jd_block +
        f"CANDIDATE RESUME (final wording — reformat, do not rewrite decisions):\n{cv_text}\n\n"
        "Generate the complete CV in Markdown format now, containing every section listed in the rules."
    )

    try:
        raw = llm_call(user_prompt=usr_prompt, system_prompt=sys_prompt,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=8192, api_key=api_key)
        result = raw.strip()

        # if the model dropped a section anyway add it back
        missing_secs = [
            sec for sec in section_names
            if sec.upper() not in result.upper()
        ]
        for sec in missing_secs:
            if sec in section_overrides:
                applied = [line for line in section_overrides[sec].splitlines() if line.strip()]
            else:
                lines = resume.sections.get(sec, [])
                if not lines:
                    continue
                applied, _, _ = _apply_rewrites(sec, lines, acc_map, rewrite_suggestions, rewrite_decisions, mentor_overrides)
            result += f"\n\n## {sec}\n---\n" + "\n".join(f"- {line}" for line in applied)
        return result
    except Exception as e:
        # this used to return the error string as the "generated CV" on a 200
        print(f"cv generation failed: {e}")
        raise


def _long_date(day: date) -> str:
    """"September 27, 2026". strftime's %-d isn't supported on Windows"""
    return f"{day:%B} {day.day}, {day.year}"


def gen_cover_letter(
    resume: ParsedResume,
    job_description: str,
    provider: str,
    local_endpoint: str,
    model: str = "",
    api_key: str = "",
) -> str:
    """generate a professional cover letter from resume and optional JD."""
    resume_text = resume.to_llm_prompt()

    sys_prompt = (
        "You are an expert cover letter writer. Generate a professional, compelling cover letter "
        "that connects the candidate's experience to the target role. "
        "Never invent employers, dates, credentials, projects, or metrics. "
        "Write in a grounded, conversational tone — confident but not sycophantic. "
        f"\n\nBANNED WORDS (never use these): {_BANNED_WORDS}\n"
        "\nFORMATTING RULES — follow these exactly:\n"
        "1. Output ONLY the cover letter in Markdown format, nothing else.\n"
        "2. 300–400 words (3–4 paragraphs).\n"
        "3. Start with # Name, contact on one line via ` | `.\n"
        "4. The exact date given below (DATE TO USE) on its own line, formatted like 'January 1, 2025'. "
        "Never invent or guess a different date.\n"
        "5. Opening: hook, mention role/company, state fit.\n"
        "6. Body (1–2 paras): highlight relevant experience with specific examples.\n"
        "7. Closing: enthusiasm, call to action, thanks.\n"
        "8. End with 'Sincerely,' followed by name.\n"
        "9. No preamble — cover letter text only."
    )

    jd_block = (
        f"JOB DESCRIPTION:\n{job_description}\n\n" if job_description.strip()
        else "JOB DESCRIPTION:\nNone provided. Write a general-purpose cover letter.\n\n"
    )

    usr_prompt = (
        f"DATE TO USE: {_long_date(date.today())}\n\n" +
        jd_block +
        f"CANDIDATE RESUME:\n{resume_text}\n\n"
        "Generate the complete cover letter in Markdown format. "
        "Keep it concise, professional, and compelling."
    )

    try:
        raw = llm_call(user_prompt=usr_prompt, system_prompt=sys_prompt,
                       provider=provider, local_endpoint=local_endpoint,
                       model=model, max_tokens=2048, api_key=api_key)
        return raw.strip()
    except Exception as e:
        print(f"cover letter generation failed: {e}")
        raise
