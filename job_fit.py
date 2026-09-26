"""One read of a job description, shared by every screen that shows job fit.

The analysis used to ask a model for the job description's keywords while the
server asked a second model (compare-resume-jd) for a match percentage, the
matched and missing skills and some tips. Two calls answered overlapping
questions differently, and the UI showed both "match" numbers side by side.

Now the model reads the job description once, for its keywords, the company and
a few tips. Everything that depends on the resume is worked out from that read
without a model: a keyword is matched when it appears in the resume, and the
match percentage is the share that do. The read depends only on the job
description, so it's cached by a hash of it and re-analysing against the same
job costs no second call.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time

from llm_output import parse_json
from prompt_registry import register
from router import llm_call

_PROFILE_PROMPT = register("jd_profile", (
    "Read this job description and return ONLY a JSON object, with no explanation, no "
    "reasoning, no markdown fences and nothing before or after it:\n"
    '{"keywords": ["Python", "Docker", "CI/CD"], "company": "Acme", "tips": ["..."]}\n'
    "keywords: every technical skill, tool, framework, methodology, certification and "
    "domain term the role asks for, as short strings.\n"
    'company: the hiring company\'s name if the description states it, otherwise "".\n'
    "tips: up to three short tips on what a candidate should emphasise for this role. "
    "Never suggest claiming experience the candidate may not have.\n\n"
    "Job description:\n"
))

_EMPTY_PROFILE = {"keywords": [], "company": "", "tips": []}

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL_SECONDS = 24 * 3600
_CACHE_MAX_ENTRIES = 128


# ------------------------------------------------------------- keyword match

def keyword_pattern(kw: str) -> re.Pattern:
    """the keyword as a whole token. \\b needs a word character on one side, so
    "C++", "C#" and ".NET" never matched, and "C" matched inside "C++" """
    return re.compile(r'(?<![a-z0-9])' + re.escape(kw.lower().strip()) + r'(?![a-z0-9+#])')


def keyword_in(kw: str, text_lower: str) -> bool:
    return bool(keyword_pattern(kw).search(text_lower))


def kw_freqs(keywords: list[str], text: str) -> dict[str, int]:
    lower = (text or "").lower()
    freqs = {}
    for kw in keywords:
        hits = keyword_pattern(kw).findall(lower)
        if hits:
            freqs[kw] = len(hits)
    return freqs


# ---------------------------------------------------------------- the one read

def _clean_profile(parsed) -> dict:
    if isinstance(parsed, list):  # a model that only returned the keywords
        parsed = {"keywords": parsed}
    if not isinstance(parsed, dict):
        raise ValueError(f"expected a JSON object for the job description, got {type(parsed).__name__}")

    keywords: list[str] = []
    seen: set[str] = set()
    for kw in parsed.get("keywords") or []:
        if not isinstance(kw, (str, int, float)):
            continue
        kw = str(kw).strip()
        if kw and len(kw) <= 60 and kw.lower() not in seen:
            seen.add(kw.lower())
            keywords.append(kw)

    tips = [str(tip).strip()[:300] for tip in parsed.get("tips") or [] if isinstance(tip, str) and tip.strip()]
    company = parsed.get("company")
    return {
        "keywords": keywords[:60],
        "company": company.strip()[:120] if isinstance(company, str) else "",
        "tips": tips[:3],
    }


def _cache_key(job_desc: str, provider: str, model: str, local_endpoint: str) -> str:
    normalised = " ".join(job_desc.split())
    return hashlib.sha256(f"{provider}|{model}|{local_endpoint}|{normalised}".encode("utf-8")).hexdigest()


def jd_profile(
    job_desc: str,
    provider: str,
    local_endpoint: str,
    model: str = "",
    api_key: str = "",
) -> dict:
    """Keywords, company and tips for a job description. One model call per distinct JD."""
    if not (job_desc or "").strip():
        return dict(_EMPTY_PROFILE)

    key = _cache_key(job_desc, provider, model, local_endpoint)
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < _CACHE_TTL_SECONDS:
            return hit[1]

    # generous budget bc free-tier models can burn most of their output on reasoning
    raw = llm_call(user_prompt=_PROFILE_PROMPT + job_desc.strip(), provider=provider,
                   local_endpoint=local_endpoint, model=model, max_tokens=4096, api_key=api_key)
    profile = _clean_profile(parse_json(raw))

    with _cache_lock:
        if len(_cache) >= _CACHE_MAX_ENTRIES:
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]), None)
        _cache[key] = (time.monotonic(), profile)
    return profile


def reset_cache() -> None:
    """Clear the profile cache. Used by tests."""
    with _cache_lock:
        _cache.clear()


# ------------------------------------------------------------------- job fit

def job_fit(resume_text: str, profile: dict) -> dict:
    """How the resume covers a job description profile. No model call, so the
    match percentage is the keyword coverage and can't disagree with it."""
    keywords = profile.get("keywords") or []
    lower = (resume_text or "").lower()
    present = [kw for kw in keywords if keyword_in(kw, lower)]
    missing = [kw for kw in keywords if not keyword_in(kw, lower)]
    return {
        "jd_keywords": keywords,
        "missing_keywords": missing,
        "strong_matches": present,
        "keyword_frequencies": kw_freqs(present, resume_text),
        "match_pct": round(100 * len(present) / len(keywords)) if keywords else None,
        "company": profile.get("company") or "",
        "tailoring_tips": profile.get("tips") or [],
    }


def compare(resume_text: str, job_desc: str, provider: str, local_endpoint: str,
            model: str = "", api_key: str = "") -> dict:
    """Job fit for a resume against a job description, reusing a cached read."""
    return job_fit(resume_text, jd_profile(job_desc, provider, local_endpoint, model=model, api_key=api_key))
