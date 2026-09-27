"""End to end through the engine, on the bundled sample, with no API key.

The replay provider answers from recorded responses (demo/replay.json). The
recordings include the failures the guards exist for, so this checks the whole
path catches them: parse the real PDF, analyse, critique, generate.
"""

import base64
import os

import pytest

import analyser
import engine_api
import job_fit
import router

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE_PDF = os.path.join(ROOT, "client", "public", "sample-resume.pdf")
SAMPLE_JOB = os.path.join(ROOT, "demo", "sample_job.txt")

SUMMARY = "Backend engineer with four years of experience building payment and data services."
CHECKOUT = "Worked on the checkout service with the payments team to improve API performance"
MIGRATION = "Helped with the migration of 12 legacy services to Kubernetes"
CI = "Set up CI with GitHub Actions to run tests on every pull request"
DOCS = "Wrote documentation for the internal deployment tool"
STRONG = "Reduced checkout latency by 35% by caching product lookups in Redis"
BUDGET = "Made a budgeting app that tracks spending across bank accounts"


@pytest.fixture
def engine(monkeypatch):
    def replay_only(*args, **kwargs):
        assert kwargs.get("provider") == "replay", "the demo test must never reach a real provider"
        return router.llm_call(*args, **kwargs)

    monkeypatch.setattr(analyser, "llm_call", replay_only)
    monkeypatch.setattr(job_fit, "llm_call", replay_only)
    # retrieval needs chromadb and a model download, neither of which the suite has
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=3: [])
    engine_api.app.config["TESTING"] = True
    with engine_api.app.test_client() as client:
        yield client


@pytest.fixture
def parsed(engine):
    with open(SAMPLE_PDF, "rb") as handle:
        data = base64.b64encode(handle.read()).decode()
    return engine.post("/parse", json={"file": data, "filename": "sample-resume.pdf"}).get_json()


def _job():
    with open(SAMPLE_JOB, encoding="utf-8") as handle:
        return handle.read()


def _analyse(engine, parsed, use_critic=False):
    response = engine.post("/analyse", json={
        "resume_json": parsed, "job_description": _job(), "provider": "replay", "use_critic": use_critic,
    })
    assert response.status_code == 200
    result = response.get_json()
    items = {item["original"]: item for section in result["rewrites"].values() for item in section}
    return result, items


def test_the_sample_parses_into_its_sections(parsed):
    assert parsed["contact"]["name"] == "Jordan Lee"
    assert set(parsed["sections"]) == {"SUMMARY", "EXPERIENCE", "PROJECTS", "EDUCATION", "SKILLS"}
    assert parsed["warnings"] == []


def test_the_parse_previews_the_score_the_analysis_will_give(engine, parsed):
    result, _items = _analyse(engine, parsed)
    assert parsed["preview"]["score"]["total"] == result["score"]["total"]
    assert parsed["preview"]["bullets"] == 10
    assert parsed["preview"]["already_strong"] == result["already_strong"] == 1
    assert parsed["preview"]["to_rewrite"] == 9


def test_sections_keep_the_resume_order(engine, parsed):
    assert list(parsed["sections"]) == ["SUMMARY", "EXPERIENCE", "PROJECTS", "EDUCATION", "SKILLS"]
    result, _items = _analyse(engine, parsed)
    assert list(result["sections"]) == list(parsed["sections"])


def test_the_guards_catch_the_recorded_fabrications(engine, parsed):
    result, items = _analyse(engine, parsed)
    assert items[MIGRATION]["verb_escalation"]["to"] == "led"
    assert items[DOCS]["new_claims"] == ["40%"]
    assert result["claim_guard"]["verb_escalation"] == 1
    assert result["claim_guard"]["new_claims"] == 1


def test_job_keywords_are_worked_in_only_where_the_bullet_supports_them(engine, parsed):
    result, items = _analyse(engine, parsed)
    assert items[CI]["keywords_added"] == [{"keyword": "CI/CD", "via": "alias", "evidence": "CI"}]
    # the summary speaks for the whole resume, which lists both languages
    assert [k["keyword"] for k in items[SUMMARY]["keywords_added"]] == ["Python", "Go"]
    # nothing in the checkout bullet says AWS
    assert items[CHECKOUT]["unsupported_keywords"] == ["AWS"]
    assert result["claim_guard"]["unsupported_keywords"] == 1


def test_the_strong_bullet_and_the_skills_are_left_alone(engine, parsed):
    result, items = _analyse(engine, parsed)
    assert items[STRONG]["strong"] is True
    assert items[STRONG]["rewritten"] == STRONG
    assert result["already_strong"] == 1
    skills = result["rewrites"]["SKILLS"][0]
    assert skills["framework_used"] == "none"


def test_the_job_fit_comes_from_one_read(engine, parsed):
    result, _items = _analyse(engine, parsed)
    assert result["company"] == "Harbor Labs"
    assert result["missing_keywords"] == ["AWS", "CI/CD", "Kafka", "Terraform", "observability"]
    assert result["match_pct"] == 50
    assert result["model"] == "replay"


def test_the_score_is_the_rubric_on_the_original(engine, parsed):
    result, _items = _analyse(engine, parsed)
    score = result["score"]
    assert score["total"] == score["quantification"] + score["action_verbs"] + score["structure"]
    assert score["bullets_scored"] == 9
    assert 0 < score["total"] < 70


def test_the_critics_repair_the_figure_and_flag_the_borrowed_stack(engine, parsed):
    result, items = _analyse(engine, parsed, use_critic=True)
    docs = items[DOCS]
    assert docs["critic"]["status"] == "repaired"
    assert "[X%]" in docs["rewritten"]
    assert "new_claims" not in docs
    assert items[BUDGET]["overstated"]["kind"] == "invented"


def test_documents_generate_offline(engine, parsed):
    result, items = _analyse(engine, parsed)
    decisions = {item["id"]: True for item in items.values() if "id" in item}
    cv = engine.post("/gen-cv", json={
        "resume_json": parsed, "job_description": _job(), "provider": "replay",
        "rewrite_suggestions": result["rewrites"], "rewrite_decisions": decisions,
    }).get_json()["cv_text"]
    assert cv.startswith("# Jordan Lee")
    for section in ("SUMMARY", "EXPERIENCE", "PROJECTS", "EDUCATION", "SKILLS"):
        assert f"## {section}" in cv
    assert "Led the migration of 12 legacy services" in cv  # an accepted rewrite made it in

    letter = engine.post("/gen-cover-letter", json={
        "resume_json": parsed, "job_description": _job(), "provider": "replay",
    }).get_json()
    assert "Harbor Labs" in letter["cover_letter_text"]
    assert letter["model"] == "replay"
