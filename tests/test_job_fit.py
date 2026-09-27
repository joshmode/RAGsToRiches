"""The one read of a job description, and the job fit worked out from it.

Two model calls used to answer overlapping questions: one extracted the JD's
keywords for the analysis, another guessed a match percentage for the UI. They
disagreed, and neither was cached. Now one cached read feeds a deterministic
match, so the percentage is the keyword coverage by construction.
"""

import json

import pytest

import analyser
import engine_api
import job_fit
from parser import ParsedResume

JD = "Backend engineer at Northwind. You'll write Python and Go, run Kubernetes and own our CI/CD."
PROFILE = {"keywords": ["Python", "Go", "Kubernetes", "CI/CD"], "company": "Northwind", "tips": ["Lead with backend work"]}
RESUME = "Built Python services and a Go CLI, deployed with Terraform"


@pytest.fixture
def model(monkeypatch):
    calls = []

    def fake(user_prompt="", **kwargs):
        calls.append(user_prompt)
        if "Read this job description" in user_prompt:
            return json.dumps(PROFILE)
        return "[]"

    monkeypatch.setattr(job_fit, "llm_call", fake)
    return calls


# ------------------------------------------------------------- keyword match

def test_keywords_ending_in_symbols_are_found():
    text = "Shipped services in C++ and C#, then ported them to .NET"
    assert job_fit.kw_freqs(["C++", "C#", ".NET"], text) == {"C++": 1, "C#": 1, ".NET": 1}
    assert all(job_fit.keyword_in(kw, text.lower()) for kw in ("C++", "C#", ".NET"))


def test_a_short_keyword_does_not_match_inside_a_longer_one():
    assert job_fit.kw_freqs(["C", "Java"], "Wrote C++ and JavaScript") == {}


# ------------------------------------------------------------------ the read

def test_the_read_is_cached_by_job_description(model):
    first = job_fit.jd_profile(JD, "gemini", "")
    # whitespace differences are the same job
    second = job_fit.jd_profile("  " + JD.replace(" ", "   ") + "\n", "gemini", "")
    assert first == second
    assert len(model) == 1


def test_a_different_model_reads_again(model):
    job_fit.jd_profile(JD, "gemini", "")
    job_fit.jd_profile(JD, "claude", "")
    assert len(model) == 2


def test_no_job_description_needs_no_call(model):
    assert job_fit.jd_profile("   ", "gemini", "") == {"keywords": [], "company": "", "tips": []}
    assert model == []


def test_the_read_is_cleaned_up():
    raw = {"keywords": ["Python", "python", "", 3, {"x": 1}, "Go"], "company": 7, "tips": ["a", "b", "c", "d"]}
    profile = job_fit._clean_profile(raw)
    assert profile["keywords"] == ["Python", "3", "Go"]
    assert profile["company"] == ""
    assert profile["tips"] == ["a", "b", "c"]


def test_a_bare_keyword_list_is_accepted():
    assert job_fit._clean_profile(["Python", "Go"])["keywords"] == ["Python", "Go"]


# ----------------------------------------------------------------- job fit

def test_match_pct_is_the_keyword_coverage():
    fit = job_fit.job_fit(RESUME, PROFILE)
    assert fit["strong_matches"] == ["Python", "Go"]
    assert fit["missing_keywords"] == ["Kubernetes", "CI/CD"]
    assert fit["match_pct"] == 50
    assert fit["company"] == "Northwind"
    assert fit["keyword_frequencies"] == {"Python": 1, "Go": 1}


def test_no_keywords_means_no_match_pct():
    assert job_fit.job_fit(RESUME, {})["match_pct"] is None


# ------------------------------------------------------- through the engine

def _resume():
    resume = ParsedResume()
    resume.raw_text = RESUME
    resume.sections = {"EXPERIENCE": ["- Worked on the checkout system with the payments team"]}
    return resume


def test_analysis_and_comparison_agree_and_share_one_read(model, monkeypatch):
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: '{"rewritten": "Rewrote it", "severity": "yellow"}')
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=3: [])
    result = analyser.analyse(resume=_resume(), job_description=JD, provider="gemini")

    engine_api.app.config["TESTING"] = True
    with engine_api.app.test_client() as client:
        compared = client.post("/compare-resume-jd", json={
            "resume_text": RESUME, "jd_text": JD, "provider": "gemini",
        }).get_json()

    assert result["match_pct"] == compared["match_pct"] == 50
    assert result["missing_keywords"] == compared["missing_keywords"]
    assert result["company"] == "Northwind"
    assert len(model) == 1  # the comparison reused the analysis's read


def test_rewrites_never_see_keywords_their_bullet_does_not_support(model, monkeypatch):
    prompts = []

    def rewrite(user_prompt="", **kwargs):
        prompts.append(user_prompt)
        return '{"rewritten": "Rewrote it", "severity": "yellow"}'

    monkeypatch.setattr(analyser, "llm_call", rewrite)
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=3: [])
    analyser.analyse(resume=_resume(), job_description=JD, provider="gemini")
    assert prompts
    assert not any("Kubernetes" in prompt for prompt in prompts)


def test_a_failed_read_is_reported_not_fatal(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("provider down")

    monkeypatch.setattr(job_fit, "llm_call", boom)
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: '{"rewritten": "Rewrote it", "severity": "yellow"}')
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=3: [])
    result = analyser.analyse(resume=_resume(), job_description=JD, provider="gemini")
    assert result["keyword_extraction_failed"] is True
    assert result["match_pct"] is None
    assert "score" in result


def test_the_compare_endpoint_reports_a_failed_read(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("secret provider detail")

    monkeypatch.setattr(job_fit, "llm_call", boom)
    engine_api.app.config["TESTING"] = True
    with engine_api.app.test_client() as client:
        response = client.post("/compare-resume-jd", json={"resume_text": RESUME, "jd_text": JD})
    assert response.status_code == 502
    assert "secret" not in response.get_data(as_text=True)
