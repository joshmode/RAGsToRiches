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

def test_escalated_bullet_earns_no_action_verb_point():
    rewrites = {"EXPERIENCE": [_graded("Helped with the migration", "Led the migration")]}
    score = analyser.calc_score(_resume(), [], [], rewrites)
    assert score["action_verbs"] == 0
    assert score["verb_escalations"] == 1


def test_honest_strong_verb_still_earns_the_point():
    rewrites = {"EXPERIENCE": [_graded("Built the API", "Developed the API gateway")]}
    score = analyser.calc_score(_resume(), [], [], rewrites)
    assert score["action_verbs"] == 8
    assert score["verb_escalations"] == 0


def test_escalation_count_is_a_diagnostic_not_a_score_component():
    rewrites = {
        "EXPERIENCE": [
            _graded("Helped with the migration", "Led the migration"),
            _graded("Assisted the team", "Directed the team"),
        ]
    }
    score = analyser.calc_score(_resume(), [], [], rewrites)
    assert score["verb_escalations"] == 2
    components = ("base", "sections", "keywords", "bullet_quality", "action_verbs", "warnings")
    assert score["total"] == max(0, min(100, sum(score[k] for k in components)))


def test_score_stays_within_bounds():
    rewrites = {"EXPERIENCE": [_graded("Built the API", "Developed the API gateway")]}
    resume = _resume({sec: ["x"] for sec in ("EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS")})
    score = analyser.calc_score(resume, ["python"], [], rewrites)
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


def test_repair_that_still_invents_reverts_to_the_pre_critic_text(monkeypatch):
    # critic FAILs, then the repair invents a different figure -> revert, fail closed.
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
    assert result["rewritten"] == pre_critic


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


def test_critic_failure_keeps_the_pre_critic_result(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("provider down")
    monkeypatch.setattr(analyser, "llm_call", boom)
    pre_critic = "Improved checkout conversion by 40%"
    result = analyser._run_critic(
        "Worked on checkout", pre_critic, {"rewritten": pre_critic},
        "usr", "sys", "gemini", "", "",
    )
    assert result["critic"]["status"] == "failed"
    assert result["rewritten"] == pre_critic


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
