"""Job keywords are only worked into a rewrite where the bullet already supports them.

Handing every rewrite the missing keywords invented experience. A keyword is now
offered to a bullet only when the bullet names it another way, names a tool that
entails it, or says the same thing in other words, and a rewrite that adds any
other job keyword is flagged.
"""

import json
import re
import time

import pytest

import analyser
import job_fit
from parser import ParsedResume
from weaving import check, plan, support


@pytest.mark.parametrize("keyword, bullet, evidence", [
    ("PostgreSQL", "Moved reporting queries onto Postgres", "Postgres"),
    ("Kubernetes", "Ran the staging cluster on k8s", "k8s"),
    ("Go", "Rewrote the ingest worker in Golang", "Golang"),
    ("CI/CD", "Set up CI with GitHub Actions", "CI"),
    ("APIs", "Designed the billing API", "API"),
    ("API", "Documented six internal APIs", "APIs"),
    ("Machine Learning", "Tuned ML models for churn", "ML"),
])
def test_another_name_for_the_keyword_supports_it(keyword, bullet, evidence):
    assert support(keyword, bullet) == {"via": "alias", "evidence": evidence}


@pytest.mark.parametrize("keyword, bullet, evidence", [
    ("Python", "Built the refunds service in Flask", "Flask"),
    ("Python programming", "Cleaned survey data with pandas", "pandas"),
    ("AWS", "Moved the batch jobs onto EKS", "EKS"),
    ("CI/CD", "Automated releases with GitHub Actions", "GitHub Actions"),
    ("JavaScript", "Built the admin screens in TypeScript", "TypeScript"),
    ("SQL", "Wrote reporting queries against PostgreSQL", "PostgreSQL"),
    ("observability", "Added Grafana dashboards for the payments service", "Grafana"),
    ("leadership", "Led a team of four through the migration", "Led"),
])
def test_a_tool_that_entails_the_keyword_supports_it(keyword, bullet, evidence):
    assert support(keyword, bullet) == {"via": "implied", "evidence": evidence}


@pytest.mark.parametrize("keyword, bullet", [
    ("code review", "Reviewed code for three junior engineers"),
    ("documentation", "Documented the deploy process"),
    ("testing", "Wrote tests for the billing API"),
    ("data analysis", "Analysed sales data for the finance team"),
    ("project management", "Managed the project budget"),
    ("automation", "Automated the weekly report"),
    ("cross-functional collaboration", "Collaborated with cross-functional teams on launch"),
])
def test_the_same_thing_in_other_words_supports_a_plain_keyword(keyword, bullet):
    assert support(keyword, bullet)["via"] == "reworded"


@pytest.mark.parametrize("keyword, bullet", [
    # nothing in the bullet implies these
    ("Kubernetes", "Wrote documentation for the internal deployment tool"),
    ("AWS", "Helped with the migration of 12 legacy services to Kubernetes"),
    ("Terraform", "Set up CI with GitHub Actions"),
    ("PostgreSQL", "Designed the database schema for orders"),
    # a product name that's also an everyday word
    ("React", "Reacted quickly to production incidents"),
    ("Sketch", "Sketched wireframes for the onboarding flow"),
    ("Segment", "Segmented users by region"),
    ("Teams", "Led two teams"),
    # the everyday reading of an evidence word
    ("leadership", "Installed LED fixtures across the site"),
    ("Python", "Heated the flask to 80 degrees"),
    ("Machine Learning", "Prepared 50 ml buffer solutions"),
    ("Go", "Took the product to go-live"),
    # CI covers only half of CI/CD's claim, and the reverse doesn't hold either
    ("continuous deployment", "Set up CI with GitHub Actions"),
    # GraphQL isn't REST
    ("REST API", "Built a GraphQL gateway"),
    # every word has to be there, not most of them
    ("stakeholder management", "Worked with stakeholders on the roadmap"),
    # too short to match by word form
    ("go", "Goes live next week"),
])
def test_unsupported_keywords_are_not_offered(keyword, bullet):
    assert support(keyword, bullet) is None


def test_a_capitalised_keyword_is_not_matched_by_word_form_when_offering():
    assert support("Code Review", "Reviewed code for the team") is None
    # but a rewrite that uses it isn't flagged as inventing it
    assert support("Code Review", "Reviewed code for the team", strict=False)["via"] == "reworded"


def test_a_summary_can_use_what_the_rest_of_the_resume_names():
    resume = "SUMMARY\nBackend engineer\nSKILLS\nPython, Go, Flask"
    assert support("Go", "Backend engineer building payment services", resume) == {"via": "resume", "evidence": "Go"}
    assert support("Kafka", "Backend engineer building payment services", resume) is None


# ---------------------------------------------------------------- plan

KEYWORDS = ["Python", "Go", "Kubernetes", "AWS", "CI/CD", "PostgreSQL", "observability"]
RESUME = """Worked on the checkout service with the payments team
Built the refunds service in Flask
Set up CI with GitHub Actions to run tests on every pull request
Added Grafana dashboards for the payments service
SKILLS
Go, Kubernetes"""


def _bullets(*texts, section="EXPERIENCE"):
    return [(text, section) for text in texts]


def test_each_bullet_is_offered_only_what_it_supports():
    offers = plan(_bullets(
        "Worked on the checkout service with the payments team",
        "Built the refunds service in Flask",
        "Set up CI with GitHub Actions to run tests on every pull request",
        "Added Grafana dashboards for the payments service",
    ), KEYWORDS, RESUME)
    assert "Worked on the checkout service with the payments team" not in offers
    assert offers["Built the refunds service in Flask"] == [{"keyword": "Python", "via": "implied", "evidence": "Flask"}]
    assert [o["keyword"] for o in offers["Set up CI with GitHub Actions to run tests on every pull request"]] == ["CI/CD"]
    assert [o["keyword"] for o in offers["Added Grafana dashboards for the payments service"]] == ["observability"]


def test_a_keyword_goes_to_at_most_two_bullets():
    flask = [f"Built service {n} in Flask" for n in range(4)]
    offers = plan(_bullets(*flask), ["Python"], "")
    assert list(offers) == flask[:2]


def test_a_bullet_gets_at_most_two_keywords_missing_ones_first():
    bullet = "Deployed the Flask API to EKS with GitHub Actions"
    offers = plan(_bullets(bullet), ["Python", "Kubernetes", "AWS", "CI/CD"], "Python")
    # Python is already on the resume, so the missing ones go first
    assert [o["keyword"] for o in offers[bullet]] == ["Kubernetes", "AWS"]


def test_a_keyword_the_bullet_states_is_not_offered_again():
    offers = plan(_bullets("Built Python services in Flask"), ["Python"], "")
    assert offers == {}


def test_no_keywords_no_offers():
    assert plan(_bullets("Built the refunds service in Flask"), [], "") == {}


def test_a_summary_line_draws_on_the_whole_resume():
    offers = plan([("Backend engineer building payment services", "SUMMARY")], ["Go", "Kafka"], RESUME)
    assert offers["Backend engineer building payment services"] == [{"keyword": "Go", "via": "resume", "evidence": "Go"}]


# ---------------------------------------------------------------- check

def test_a_supported_keyword_the_rewrite_worked_in_is_reported_with_its_evidence():
    out = check("Built the refunds service in Flask", "Built the refunds service in Python with Flask", KEYWORDS)
    assert out == {"keywords_added": [{"keyword": "Python", "via": "implied", "evidence": "Flask"}]}


def test_an_unsupported_keyword_the_rewrite_added_is_flagged():
    out = check(
        "Wrote documentation for the internal deployment tool",
        "Wrote Kubernetes deployment documentation for the internal tool on AWS",
        KEYWORDS,
    )
    assert out == {"unsupported_keywords": ["Kubernetes", "AWS"]}


def test_keywords_the_original_already_had_are_not_counted():
    assert check("Moved services to Kubernetes", "Migrated services to Kubernetes", KEYWORDS) == {}


def test_a_rewrite_that_rewords_into_the_job_term_is_not_flagged():
    out = check("Reviewed code for three juniors", "Led Code Review for three junior engineers", ["Code Review"])
    assert out["keywords_added"][0]["via"] == "reworded"
    assert "unsupported_keywords" not in out


# ------------------------------------------------------- through the analysis

JD = "Backend role. Python, Kubernetes, AWS and CI/CD."
PROFILE = {"keywords": ["Python", "Kubernetes", "AWS", "CI/CD"], "company": "", "tips": []}
REWRITES = {
    "Built the refunds service in Flask": "Built the refunds service in Python with Flask",
    "Wrote documentation for the internal deployment tool": "Wrote Kubernetes documentation for the internal deployment tool",
    "Set up CI with GitHub Actions to run tests": "Set up a CI/CD pipeline in GitHub Actions that runs the tests",
}
_LINE_RE = re.compile(r'^\[(\d+)\] \(guides: [^)]*\) (.+)$', re.MULTILINE)


@pytest.fixture
def model(monkeypatch):
    prompts = []

    def rewrite(user_prompt="", **kwargs):
        prompts.append(user_prompt)
        return json.dumps([
            {"index": int(i), "rewritten": REWRITES[text], "reasoning": "r", "framework_used": "STAR", "severity": "yellow"}
            for i, text in _LINE_RE.findall(user_prompt)
        ])

    monkeypatch.setattr(job_fit, "llm_call", lambda **kwargs: json.dumps(PROFILE))
    monkeypatch.setattr(analyser, "llm_call", rewrite)
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=3: [])
    return prompts


def _resume():
    resume = ParsedResume()
    resume.raw_text = "\n".join(REWRITES)
    resume.sections = {"EXPERIENCE": [f"- {bullet}" for bullet in REWRITES]}
    return resume


def _items(result):
    return {item["original"]: item for section in result["rewrites"].values() for item in section}


def test_each_bullet_is_sent_only_the_keywords_it_supports(model):
    analyser.analyse(resume=_resume(), job_description=JD, provider="gemini")
    prompt = model[0]
    assert "job keywords: Python) Built the refunds service in Flask" in prompt
    assert "job keywords: CI/CD) Set up CI with GitHub Actions" in prompt
    assert "(guides: none) Wrote documentation" in prompt
    assert "Kubernetes" not in prompt and "AWS" not in prompt
    assert "JOB KEYWORDS:" in prompt


def test_a_worked_in_keyword_is_reported_and_an_unsupported_one_flagged(model):
    result = analyser.analyse(resume=_resume(), job_description=JD, provider="gemini")
    items = _items(result)
    assert items["Built the refunds service in Flask"]["keywords_added"] == [
        {"keyword": "Python", "via": "implied", "evidence": "Flask"},
    ]
    assert items["Wrote documentation for the internal deployment tool"]["unsupported_keywords"] == ["Kubernetes"]
    assert result["claim_guard"]["unsupported_keywords"] == 1


def test_no_job_description_means_no_keywords(model):
    result = analyser.analyse(resume=_resume(), job_description="", provider="gemini")
    assert "JOB KEYWORDS" not in model[0]
    for item in _items(result).values():
        assert "keywords_added" not in item and "unsupported_keywords" not in item


def test_a_slow_read_doesnt_hold_up_the_rewrites_but_they_are_still_checked(model, monkeypatch):
    def slow(**kwargs):
        time.sleep(0.3)
        return json.dumps(PROFILE)

    monkeypatch.setattr(job_fit, "llm_call", slow)
    monkeypatch.setattr(analyser, "_JD_WAIT_SECONDS", 0.01)
    result = analyser.analyse(resume=_resume(), job_description=JD, provider="gemini")
    assert "job keywords" not in model[0]
    assert _items(result)["Wrote documentation for the internal deployment tool"]["unsupported_keywords"] == ["Kubernetes"]
    assert result["match_pct"] is not None
