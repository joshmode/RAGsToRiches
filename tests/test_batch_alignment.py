"""Batched rewrites must land on the bullet they were written for.

Results used to be matched to bullets by position alone, so a model that answered
two bullets in swapped order put "Led migration of 12 services" on the Kafka bullet.
"""

import json
import threading

import pytest

import analyser

MIGRATION = "Helped migrate 12 services to Kubernetes"
KAFKA = "Maintained the Kafka consumers for order events"
TESTS = "Wrote unit tests for the payments API"

MIGRATION_REWRITE = {"rewritten": "Migrated 12 services to Kubernetes with the platform team", "severity": "yellow"}
KAFKA_REWRITE = {"rewritten": "Maintained Kafka consumers that process order events", "severity": "yellow"}
TESTS_REWRITE = {"rewritten": "Wrote unit tests covering the payments API", "severity": "yellow"}


def _chunk(monkeypatch, batch_reply, single_reply=None):
    calls = []

    def fake(user_prompt="", **kwargs):
        calls.append(user_prompt)
        if "BULLETS TO REWRITE" in user_prompt:
            return json.dumps(batch_reply)
        return json.dumps(single_reply(user_prompt) if single_reply else {"rewritten": "x", "severity": "red"})

    monkeypatch.setattr(analyser, "llm_call", fake)
    items = [(MIGRATION, []), (KAFKA, []), (TESTS, [])]
    return analyser.rewrite_chunk(items, "gemini", ""), calls


def test_indexes_put_swapped_answers_back_in_place(monkeypatch):
    reply = [
        {**KAFKA_REWRITE, "index": 1},
        {**MIGRATION_REWRITE, "index": 0},
        {**TESTS_REWRITE, "index": 2},
    ]
    out, calls = _chunk(monkeypatch, reply)
    assert [item["original"] for item in out] == [MIGRATION, KAFKA, TESTS]
    assert out[0]["rewritten"] == MIGRATION_REWRITE["rewritten"]
    assert out[1]["rewritten"] == KAFKA_REWRITE["rewritten"]
    assert "index" not in out[0]
    assert len(calls) == 1


def test_one_based_indexes_are_accepted(monkeypatch):
    reply = [{**MIGRATION_REWRITE, "index": 1}, {**KAFKA_REWRITE, "index": 2}, {**TESTS_REWRITE, "index": 3}]
    out, calls = _chunk(monkeypatch, reply)
    assert out[1]["rewritten"] == KAFKA_REWRITE["rewritten"]
    assert len(calls) == 1


def test_swapped_answers_without_indexes_are_caught(monkeypatch):
    # the exact failure: positions swapped, nothing in the reply says so
    def single(prompt):
        for original, rewrite in ((MIGRATION, MIGRATION_REWRITE), (KAFKA, KAFKA_REWRITE), (TESTS, TESTS_REWRITE)):
            if original in prompt:
                return rewrite
        raise AssertionError("unexpected prompt")

    out, calls = _chunk(monkeypatch, [KAFKA_REWRITE, MIGRATION_REWRITE, TESTS_REWRITE], single)
    assert out[0]["rewritten"] == MIGRATION_REWRITE["rewritten"]
    assert out[1]["rewritten"] == KAFKA_REWRITE["rewritten"]
    assert len(calls) == 4  # the batch, then one call per bullet


def test_duplicate_indexes_fall_back(monkeypatch):
    reply = [{**MIGRATION_REWRITE, "index": 0}, {**KAFKA_REWRITE, "index": 0}, {**TESTS_REWRITE, "index": 2}]
    _out, calls = _chunk(monkeypatch, reply)
    assert len(calls) == 4


def test_similar_bullets_are_not_mistaken_for_a_swap():
    originals = ["Built the billing service API", "Migrated the billing service to Kafka"]
    parsed = [
        {"rewritten": "Built the billing service API and its gateway"},
        {"rewritten": "Migrated the billing service to Kafka event streams"},
    ]
    assert analyser._align_batch(originals, parsed) == parsed


def test_the_fallback_calls_run_side_by_side(monkeypatch):
    # three calls must all be in flight at once to get past the barrier
    barrier = threading.Barrier(3, timeout=5)

    def fake(user_prompt="", **kwargs):
        if "BULLETS TO REWRITE" in user_prompt:
            return "not json"
        barrier.wait()
        return json.dumps({"rewritten": "Rewritten bullet", "severity": "yellow"})

    monkeypatch.setattr(analyser, "llm_call", fake)
    out = analyser.rewrite_chunk([(MIGRATION, []), (KAFKA, []), (TESTS, [])], "gemini", "")
    assert [item["rewritten"] for item in out] == ["Rewritten bullet"] * 3


@pytest.mark.parametrize("parsed", ["not a list", [{"rewritten": "a"}], [1, 2, 3]])
def test_malformed_batches_are_rejected(parsed):
    with pytest.raises(ValueError):
        analyser._align_batch([MIGRATION, KAFKA, TESTS], parsed)


def test_each_bullet_names_its_own_frameworks(monkeypatch):
    from vector_db import FwHit

    def hit(name):
        return FwHit(document=f"{name} guide text", framework=name, category="structure", score=0.9)

    prompts = []

    def fake(user_prompt="", **kwargs):
        prompts.append(user_prompt)
        return json.dumps([{**MIGRATION_REWRITE, "index": 0}, {**KAFKA_REWRITE, "index": 1}])

    monkeypatch.setattr(analyser, "llm_call", fake)
    analyser.rewrite_chunk(
        [(MIGRATION, [hit("XYZ"), hit("STAR"), hit("Verbs")]), (KAFKA, [hit("STAR"), hit("Metrics")])],
        "gemini", "",
    )
    prompt = prompts[0]
    assert f"[0] (guides: F1, F2, F3) {MIGRATION}" in prompt
    assert f"[1] (guides: F2, F4) {KAFKA}" in prompt
    assert prompt.count("STAR guide text") == 1
