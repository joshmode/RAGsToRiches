"""Tests for the deterministic resume score.

The rubric grades the candidate's own bullets. The tests pin the three things
the old score got wrong: it gave away points for existing, it graded the model's
rewrite instead of the candidate's text, and it called ungraded sections 100%.
"""

import pytest

import analyser
import scoring
from parser import ParsedResume


# ------------------------------------------------------------- quantification

@pytest.mark.parametrize("text", [
    "Cut p95 latency by 40% by batching predictions",
    "Managed 5 engineers across two time zones",
    "Migrated 12 services to Kubernetes 1.29",
    "Saved $20k a year by consolidating licences",
    "Grew weekly active users 3x in six months",
])
def test_figures_count_as_quantified(text):
    assert scoring.is_quantified(text)


@pytest.mark.parametrize("text", [
    "Built the backend with Python 3 and React 18",
    "Improved conversion by [X%] for [N users]",
    "Worked there from 2019 to 2023",
    "Wrote documentation for the deployment tool",
])
def test_versions_placeholders_and_dates_are_not_quantified(text):
    assert not scoring.is_quantified(text)


# --------------------------------------------------------------- action verbs

@pytest.mark.parametrize("text, expected", [
    ("Led the migration to Postgres", 1.0),
    ("Built an internal CLI for deploys", 1.0),
    ("Presented findings to the leadership team", 1.0),  # past tense the ladder doesn't list
    ("Lead a team of four engineers", 1.0),              # present tense for a current role
    ("Managing the on-call rota", 1.0),
    ("Collaborated with design on onboarding", 0.5),
    ("Helped with the database migration", 0.0),
    ("Responsible for writing unit tests", 0.0),
    ("Worked on the checkout system", 0.0),
    ("The API was rebuilt last year", 0.0),
])
def test_action_verb_strength(text, expected):
    assert scoring.action_verb_strength(text) == expected


# ------------------------------------------------------------------ structure

def test_first_person_is_penalised():
    assert not scoring.structure_checks("I built the API that our team uses")["no_first_person"]


def test_abbreviations_are_not_first_person():
    checks = scoring.structure_checks("Tuned disk I/O for batch jobs, e.g. nightly exports to the US region")
    assert checks["no_first_person"]


def test_filler_is_penalised():
    assert not scoring.structure_checks("Responsible for various reporting tasks")["no_filler"]


def test_length_is_graded():
    assert scoring.structure_checks("Built it")["length"] == 0.0
    assert scoring.structure_checks("Built the internal deployment dashboard for the platform team")["length"] == 1.0


# ------------------------------------------------------------------- combined

STRONG = "Reduced checkout latency by 35% by caching product lookups in Redis"
WEAK = "Helped with the migration of legacy services"


def test_a_strong_bullet_scores_full_marks():
    signals = scoring.bullet_signals(STRONG)
    assert signals["score"] == 100
    assert scoring.is_strong(signals)


def test_weights_add_up_to_the_total():
    score = scoring.score_bullets([("EXPERIENCE", STRONG), ("EXPERIENCE", WEAK)])
    assert score["total"] == score["quantification"] + score["action_verbs"] + score["structure"]
    assert score["weights"] == {"quantification": 40, "action_verbs": 30, "structure": 30}


def test_the_total_is_the_per_bullet_average():
    only_strong = scoring.score_bullets([("EXPERIENCE", STRONG)])
    mixed = scoring.score_bullets([("EXPERIENCE", STRONG), ("EXPERIENCE", WEAK)])
    assert only_strong["total"] == 100
    assert mixed["total"] < only_strong["total"]
    assert mixed["bullets_scored"] == 2


def test_no_bullets_means_no_points():
    score = scoring.score_bullets([], sections=["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"])
    assert score["total"] == 0
    assert score["bullets_scored"] == 0


def test_an_ungraded_section_is_not_excellent():
    score = scoring.score_bullets([("EXPERIENCE", STRONG)], sections=["EXPERIENCE", "SKILLS"])
    assert score["section_scores"]["SKILLS"]["quality"] is None
    assert score["section_scores"]["SKILLS"]["bullet_count"] == 0


def test_skills_lines_never_reach_the_total():
    with_skills = scoring.score_bullets([("EXPERIENCE", STRONG), ("SKILLS", "Python, Go, Kubernetes, Terraform")])
    assert with_skills["total"] == 100


def test_work_sections_outrank_others_for_the_total():
    score = scoring.score_bullets([("EXPERIENCE", STRONG), ("AWARDS", WEAK)])
    assert score["total"] == 100
    assert score["section_scores"]["AWARDS"]["quality"] < 100


# ----------------------------------------------------------- through analyser

def _resume(sections):
    resume = ParsedResume()
    resume.raw_text = "\n".join(line for lines in sections.values() for line in lines)
    resume.sections = sections
    return resume


WEAK_RESUME = {
    "EXPERIENCE": [
        "Software Engineer, Acme Corp | 2021 - 2023",
        "- Helped with the migration of legacy services",
        "- Worked on the checkout system with the payments team",
        "- Responsible for writing unit tests for the API",
    ],
    "EDUCATION": ["BSc Computer Science, 2021"],
    "SKILLS": ["Python, Go, Kubernetes"],
    "PROJECTS": ["Portfolio site"],
}


def test_section_headings_earn_nothing():
    # the old score gave this resume 30 base + 32 for its four headings
    score = analyser.calc_score(_resume(WEAK_RESUME))
    assert score["total"] < 30
    assert score["bullets_scored"] == 3


def test_the_score_ignores_what_the_model_thought():
    resume = _resume(WEAK_RESUME)
    red = {"EXPERIENCE": [{"original": WEAK, "rewritten": "Led the migration", "severity": "red"}]}
    green = {"EXPERIENCE": [{"original": WEAK, "rewritten": "Led the migration", "severity": "green"}]}
    assert analyser.calc_score(resume, red)["total"] == analyser.calc_score(resume, green)["total"]
