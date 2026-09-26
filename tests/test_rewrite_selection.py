"""Which lines get sent to the model for rewriting.

Every call costs tokens and time. A skills list has nothing an XYZ rewrite can
add, and a bullet that is already quantified, action-led and clean only risks
being made worse, so neither is sent.
"""

import json

import pytest

import analyser
from parser import ParsedResume

STRONG = "Reduced checkout latency by 35% by caching product lookups in Redis"
WEAK = "Worked on the checkout system with the payments team"


@pytest.fixture
def prompts(monkeypatch):
    seen = []

    def fake_llm_call(user_prompt="", system_prompt="", **kwargs):
        seen.append(user_prompt)
        if "BULLETS TO REWRITE" in user_prompt:
            count = user_prompt.count("\n[")
            return json.dumps([
                {"index": i, "rewritten": "Rewrote it", "framework_used": "STAR", "severity": "yellow"}
                for i in range(count)
            ])
        return json.dumps({"rewritten": "Rewrote it", "framework_used": "STAR", "severity": "yellow"})

    monkeypatch.setattr(analyser, "llm_call", fake_llm_call)
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=2: [])
    return seen


def _analyse(sections):
    resume = ParsedResume()
    resume.raw_text = "\n".join(line for lines in sections.values() for line in lines)
    resume.sections = sections
    return analyser.analyse(resume=resume, job_description="", provider="gemini")


def test_skills_lines_are_never_sent(prompts):
    _analyse({
        "EXPERIENCE": [f"- {WEAK}"],
        "SKILLS": ["Python, Go, Kubernetes, Terraform, AWS", "Frameworks: React, Flask, Django"],
        "CERTIFICATIONS": ["AWS Certified Solutions Architect Associate, 2023"],
    })
    sent = "\n".join(prompts)
    assert WEAK in sent
    assert "Kubernetes" not in sent
    assert "Flask" not in sent
    assert "Solutions Architect" not in sent


def test_list_lines_in_other_sections_are_never_sent(prompts):
    _analyse({
        "EXPERIENCE": [f"- {WEAK}"],
        "EDUCATION": ["Relevant coursework: Algorithms, Databases, Operating Systems, Networks"],
    })
    assert "Operating Systems" not in "\n".join(prompts)


def test_a_strong_bullet_is_left_alone(prompts):
    result = _analyse({"EXPERIENCE": [f"- {STRONG}", f"- {WEAK}"]})
    assert STRONG not in "\n".join(prompts)
    item = next(rw for rw in result["rewrites"]["EXPERIENCE"] if rw["original"] == STRONG)
    assert item["strong"] is True
    assert item["rewritten"] == STRONG
    assert item["framework_used"] == "none"
    assert result["already_strong"] == 1


def test_weak_bullets_still_get_rewritten(prompts):
    result = _analyse({"EXPERIENCE": [f"- {WEAK}"]})
    item = result["rewrites"]["EXPERIENCE"][0]
    assert item["rewritten"] == "Rewrote it"
    assert item["signals"]["action_verb"] == 0.0
