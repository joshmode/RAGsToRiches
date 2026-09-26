"""Integration tests for the claim guards inside the rewrite pipeline.

Covers the wiring rather than the rules themselves (those live in
``test_claims.py``): that a rewrite carries its findings, that the scoring rubric
cannot reward an escalation, and that the critic paths fail safe.
"""

import analyser
from parser import ParsedResume


def _resume(sections=None):
    resume = ParsedResume()
    resume.raw_text = "resume text"
    resume.contact = {}
    resume.sections = sections if sections is not None else {"EXPERIENCE": ["a bullet"]}
    resume.warnings = []
    resume.ocr_used = False
    return resume


def _graded(original, rewritten, severity="green"):
    """A rewrite as the pipeline would produce it, findings attached."""
    return analyser._finalise(
        {"rewritten": rewritten, "framework_used": "STAR", "severity": severity},
        original,
    )


# ------------------------------------------------------------------ _finalise

def test_finalise_attaches_an_escalation_finding():
    item = _graded("Helped with the migration", "Led the migration")
    assert item["original"] == "Helped with the migration"
    assert item["verb_escalation"]["to"] == "led"


def test_finalise_leaves_no_key_when_the_rewrite_is_honest():
    item = _graded("Built the API", "Developed the API gateway")
    assert "verb_escalation" not in item
    assert "new_claims" not in item


def test_finalise_flags_an_invented_figure_without_the_critic():
    # the regex check is free, so it runs whether or not the critic toggle is on
    item = _graded("Worked on checkout", "Improved checkout conversion by 40%")
    assert item["new_claims"] == ["40%"]


def test_finalise_leaves_a_placeholder_alone():
    item = _graded("Worked on checkout", "Improved checkout conversion by [X%]")
    assert "new_claims" not in item


def test_chunked_rewrites_carry_the_figure_check(monkeypatch):
    monkeypatch.setattr(
        analyser, "llm_call",
        lambda *a, **k: '[{"rewritten": "Cut costs by 30%", "framework_used": "STAR", "severity": "red"},'
                        ' {"rewritten": "Shipped the API", "framework_used": "STAR", "severity": "red"}]',
    )
    out = analyser.rewrite_chunk([("Cut costs", []), ("Shipped the API", [])], "gemini", "")
    assert out[0]["new_claims"] == ["30%"]
    assert "new_claims" not in out[1]


def test_finalise_clears_a_stale_finding():
    # A repaired rewrite must not keep the escalation flag from its earlier text.
    stale = {"rewritten": "Supported the migration", "verb_escalation": {"to": "led"}}
    item = analyser._finalise(stale, "Helped with the migration")
    assert "verb_escalation" not in item


def test_finalise_normalises_a_bad_severity():
    item = analyser._finalise({"rewritten": "Built X", "severity": "banana"}, "Built X")
    assert item["severity"] == "yellow"


def test_finalise_survives_a_missing_rewrite():
    item = analyser._finalise({"severity": "red"}, "Helped with X")
    assert "verb_escalation" not in item


# ---------------------------------------------------------------- calc_score

HELPED = "Helped with the migration of the billing service"
ASSISTED = "Assisted the team with release planning each sprint"


def test_escalated_rewrite_cannot_raise_the_score():
    resume = _resume({"EXPERIENCE": [f"- {HELPED}"]})
    before = analyser.calc_score(resume)
    rewrites = {"EXPERIENCE": [_graded(HELPED, "Led the migration of the billing service")]}
    after = analyser.calc_score(resume, rewrites)
    assert after["total"] == before["total"]
    assert after["action_verbs"] == 0
    assert after["verb_escalations"] == 1


def test_honest_strong_verb_still_earns_the_point():
    resume = _resume({"EXPERIENCE": ["- Built the internal API gateway for the platform team"]})
    score = analyser.calc_score(resume)
    assert score["action_verbs"] == 30
    assert score["verb_escalations"] == 0


def test_escalation_count_is_a_diagnostic_not_a_score_component():
    resume = _resume({"EXPERIENCE": [f"- {HELPED}", f"- {ASSISTED}"]})
    rewrites = {
        "EXPERIENCE": [
            _graded(HELPED, "Led the migration of the billing service"),
            _graded(ASSISTED, "Directed release planning each sprint"),
        ]
    }
    score = analyser.calc_score(resume, rewrites)
    assert score["verb_escalations"] == 2
    components = ("quantification", "action_verbs", "structure")
    assert score["total"] == sum(score[k] for k in components)


def test_score_stays_within_bounds():
    bullet = "- Reduced checkout latency by 35% by caching product lookups in Redis"
    resume = _resume({sec: [bullet] for sec in ("EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS")})
    score = analyser.calc_score(resume)
    assert 0 <= score["total"] <= 100


# -------------------------------------------------------------- numeric critic

def test_critic_is_skipped_when_no_new_figure_appears(monkeypatch):
    called = []
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: called.append(1) or "PASS")
    result = analyser._run_critic(
        "Cut latency by 40%", "Reduced latency 40% by batching",
        {"rewritten": "Reduced latency 40% by batching"},
        "usr", "sys", "gemini", "", "",
    )
    assert result["critic"]["status"] == "skipped"
    assert called == []


def test_critic_passes_a_supported_figure(monkeypatch):
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: "PASS: supported by the original")
    result = analyser._run_critic(
        "Worked on checkout", "Improved checkout conversion by 40%",
        {"rewritten": "Improved checkout conversion by 40%"},
        "usr", "sys", "gemini", "", "",
    )
    assert result["critic"]["status"] == "passed"


def test_repair_that_still_invents_falls_back_to_the_original(monkeypatch):
    # critic FAILs, then the repair invents a different figure -> the candidate's
    # own bullet stands, fail closed.
    replies = iter([
        "FAIL: 40% is not in the original",
        '{"rewritten": "Improved checkout conversion by 25%", "severity": "yellow"}',
    ])
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: next(replies))
    pre_critic = "Improved checkout conversion by 40%"
    result = analyser._run_critic(
        "Worked on checkout", pre_critic, {"rewritten": pre_critic},
        "usr", "sys", "gemini", "", "",
    )
    assert result["critic"]["status"] == "failed"
    assert result["rewritten"] == "Worked on checkout"
    assert "new_claims" not in analyser._finalise(result, "Worked on checkout")


def test_clean_repair_is_accepted(monkeypatch):
    replies = iter([
        "FAIL: 40% is not in the original",
        '{"rewritten": "Improved checkout conversion by [X%]", "severity": "yellow"}',
    ])
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: next(replies))
    result = analyser._run_critic(
        "Worked on checkout", "Improved checkout conversion by 40%",
        {"rewritten": "Improved checkout conversion by 40%"},
        "usr", "sys", "gemini", "", "",
    )
    assert result["critic"]["status"] == "repaired"
    assert "[X%]" in result["rewritten"]


def test_unreachable_critic_keeps_the_rewrite_flagged(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("provider down")
    monkeypatch.setattr(analyser, "llm_call", boom)
    pre_critic = "Improved checkout conversion by 40%"
    result = analyser._run_critic(
        "Worked on checkout", pre_critic, {"rewritten": pre_critic},
        "usr", "sys", "gemini", "", "",
    )
    assert result["critic"]["status"] == "unavailable"
    assert "provider down" not in result["critic"]["reason"]
    assert result["rewritten"] == pre_critic
    # unchecked, so the figure is still flagged for the candidate
    assert analyser._finalise(result, "Worked on checkout")["new_claims"] == ["40%"]


# ---------------------------------------------------------- qualitative critic

def test_qualitative_critic_flags_an_overstated_rewrite(monkeypatch):
    monkeypatch.setattr(
        analyser, "llm_call",
        lambda *a, **k: '[{"index":0,"verdict":"overstated","kind":"credit","reason":"team work claimed personally"}]',
    )
    out = analyser.run_qualitative_critic(
        [("Was on the team that shipped the API", "Shipped the API")], "gemini", "",
    )
    assert out[0]["kind"] == "credit"


def test_qualitative_critic_returns_none_for_clean_pairs(monkeypatch):
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: '[{"index":0,"verdict":"ok","kind":"none"}]')
    out = analyser.run_qualitative_critic([("Built the API", "Built the REST API")], "gemini", "")
    assert out == [None]


def test_qualitative_critic_skips_unchanged_bullets_without_calling_the_model(monkeypatch):
    called = []
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: called.append(1) or "[]")
    out = analyser.run_qualitative_critic([("Built the API", "Built the API")], "gemini", "")
    assert out == [None]
    assert called == []


def test_qualitative_critic_aligns_verdicts_with_original_positions(monkeypatch):
    # The unchanged middle pair is not sent, so verdicts must map back by position.
    monkeypatch.setattr(
        analyser, "llm_call",
        lambda *a, **k: '[{"verdict":"ok"},{"verdict":"overstated","kind":"role","reason":"r"}]',
    )
    out = analyser.run_qualitative_critic(
        [
            ("Built the API", "Built the REST API"),
            ("Unchanged bullet", "Unchanged bullet"),
            ("Helped the team", "Directed the team"),
        ],
        "gemini", "",
    )
    assert out[0] is None
    assert out[1] is None
    assert out[2]["kind"] == "role"


def test_qualitative_critic_ignores_a_length_mismatch(monkeypatch):
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: '[{"verdict":"overstated"}]')
    out = analyser.run_qualitative_critic(
        [("Built A", "Rebuilt A"), ("Built B", "Rebuilt B")], "gemini", "",
    )
    assert out == [None, None]


def test_qualitative_critic_survives_a_provider_failure(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("provider down")
    monkeypatch.setattr(analyser, "llm_call", boom)
    out = analyser.run_qualitative_critic([("Helped X", "Led X")], "gemini", "")
    assert out == [None]


def test_qualitative_critic_normalises_an_unknown_kind(monkeypatch):
    monkeypatch.setattr(
        analyser, "llm_call",
        lambda *a, **k: '[{"verdict":"overstated","kind":"nonsense","reason":"r"}]',
    )
    out = analyser.run_qualitative_critic([("Helped X", "Led X")], "gemini", "")
    assert out[0]["kind"] == "role"

