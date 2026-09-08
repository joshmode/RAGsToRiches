"""End-to-end test that the real pipeline emits progress, with no live model.

``tests/test_engine_stream.py`` stubs ``analyse`` to test the transport. This
stubs the *model* instead and runs the genuine ``analyse`` function, so the two
together cover the whole path.
"""

import json

import pytest

import analyser
from parser import ParsedResume


@pytest.fixture
def offline(monkeypatch):
    """A pipeline with no network: canned rewrites and canned retrieval."""
    def fake_llm_call(user_prompt="", system_prompt="", **kwargs):
        # Keyword extraction asks for an array of strings.
        if "Extract every technical skill" in user_prompt:
            return json.dumps(["python", "docker"])
        # Chunked rewrite: one object per numbered bullet in the prompt.
        count = user_prompt.count("[") if "BULLETS TO REWRITE" in user_prompt else 1
        count = max(1, count)
        return json.dumps([
            {
                "rewritten": f"Built component {i}",
                "reasoning": "tightened",
                "framework_used": "STAR",
                "severity": "green",
            }
            for i in range(count)
        ])

    monkeypatch.setattr(analyser, "llm_call", fake_llm_call)
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=2: [])
    return fake_llm_call


def _resume():
    resume = ParsedResume()
    resume.raw_text = "Helped with the migration\nWorked on the checkout system"
    resume.contact = {}
    resume.sections = {
        "EXPERIENCE": [
            "Helped with the database migration",
            "Worked on the checkout system",
            "Supported the release process",
        ]
    }
    resume.warnings = []
    resume.ocr_used = False
    return resume


def test_analyse_emits_the_expected_stages(offline):
    seen = []
    result = analyser.analyse(
        resume=_resume(), job_description="python docker",
        provider="gemini", progress=seen.append,
    )
    stages = [event["stage"] for event in seen]
    assert stages[0] == "started"
    for expected in ("planned", "retrieved", "keywords", "rewriting", "chunk", "scored"):
        assert expected in stages, f"missing stage {expected!r}: {stages}"
    assert "score" in result


def test_chunk_events_account_for_every_chunk(offline):
    seen = []
    analyser.analyse(
        resume=_resume(), job_description="", provider="gemini", progress=seen.append,
    )
    rewriting = next(e for e in seen if e["stage"] == "rewriting")
    chunks = [e for e in seen if e["stage"] == "chunk"]
    assert len(chunks) == rewriting["chunks"]
    assert [c["completed"] for c in chunks] == list(range(1, len(chunks) + 1))
    assert all(c["total"] == rewriting["chunks"] for c in chunks)


def test_progress_events_are_json_serialisable(offline):
    seen = []
    analyser.analyse(
        resume=_resume(), job_description="", provider="gemini", progress=seen.append,
    )
    for event in seen:
        json.dumps(event)  # raises if the payload cannot cross the wire


def test_result_is_identical_with_and_without_progress(offline):
    without = analyser.analyse(resume=_resume(), job_description="", provider="gemini")
    with_progress = analyser.analyse(
        resume=_resume(), job_description="", provider="gemini", progress=lambda e: None,
    )
    without.pop("timing", None)
    with_progress.pop("timing", None)
    assert without == with_progress


def test_a_broken_consumer_does_not_break_the_analysis(offline):
    def hostile(event):
        raise RuntimeError("consumer exploded")

    result = analyser.analyse(
        resume=_resume(), job_description="", provider="gemini", progress=hostile,
    )
    assert "score" in result


def test_guard_summary_is_reported(offline):
    result = analyser.analyse(resume=_resume(), job_description="", provider="gemini")
    assert set(result["claim_guard"]) == {"verb_escalation", "overstated"}
    assert "prompt_versions" in result
    assert "prompt_set_version" in result
