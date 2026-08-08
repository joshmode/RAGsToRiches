"""Tests for the claim-detector evaluation harness.

Two jobs: check the metric arithmetic, and act as a regression gate so a change
that quietly degrades the detectors fails the build.
"""

import json
import os

import pytest

import eval_claims
from eval_claims import Outcome, evaluate, load_cases

EVAL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "eval")
DEV_SET = os.path.join(EVAL_DIR, "claim_eval_set.json")
HOLDOUT_SET = os.path.join(EVAL_DIR, "claim_eval_holdout.json")


# --------------------------------------------------------------- metric maths

def test_perfect_detector_scores_one():
    outcome = Outcome(true_positive=5, true_negative=5)
    assert outcome.precision == 1.0
    assert outcome.recall == 1.0
    assert outcome.f1 == 1.0


def test_precision_and_recall_are_distinct():
    outcome = Outcome(true_positive=8, false_positive=2, false_negative=4)
    assert outcome.precision == pytest.approx(0.8)
    assert outcome.recall == pytest.approx(2 / 3)


def test_detector_that_never_fires_has_zero_recall():
    outcome = Outcome(false_negative=10, true_negative=5)
    assert outcome.recall == 0.0


def test_record_returns_the_right_quadrant():
    outcome = Outcome()
    assert outcome.record(True, True) == "TP"
    assert outcome.record(True, False) == "FP"
    assert outcome.record(False, True) == "FN"
    assert outcome.record(False, False) == "TN"
    assert outcome.total == 4


# ----------------------------------------------------------------- fixture set

@pytest.mark.parametrize("path", [DEV_SET, HOLDOUT_SET])
def test_eval_set_is_well_formed(path):
    cases = load_cases(path)
    assert cases
    ids = [case["id"] for case in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    for case in cases:
        assert case["original"].strip()
        assert case["rewritten"].strip()
        assert set(case["labels"]) == set(eval_claims.DETECTORS)
        for value in case["labels"].values():
            assert isinstance(value, bool)


def test_development_set_has_fifty_cases():
    assert len(load_cases(DEV_SET)) == 50


def test_sets_do_not_overlap():
    # A held-out case that also sits in the development set is not held out.
    dev = {(c["original"], c["rewritten"]) for c in load_cases(DEV_SET)}
    holdout = {(c["original"], c["rewritten"]) for c in load_cases(HOLDOUT_SET)}
    assert not dev & holdout


def test_both_label_classes_are_represented():
    for path in (DEV_SET, HOLDOUT_SET):
        cases = load_cases(path)
        for detector in eval_claims.DETECTORS:
            values = {case["labels"][detector] for case in cases}
            assert values == {True, False}, f"{path} has no contrast for {detector}"


# -------------------------------------------------------------- regression gate

def test_development_set_has_no_disagreements():
    # The detectors were fixed against this set, so anything less is a regression.
    _per_detector, _combined, disagreements = evaluate(load_cases(DEV_SET))
    assert disagreements == [], f"regression on the development set: {disagreements}"


def test_holdout_recall_floor():
    # Deliberately a floor, not a target. Raising this by tuning against the
    # held-out set would destroy the only unbiased measurement available.
    _per_detector, combined, _disagreements = evaluate(load_cases(HOLDOUT_SET))
    assert combined.recall >= 0.55, f"held-out recall fell to {combined.recall:.2f}"


def test_holdout_precision_floor():
    # Precision matters more than recall: a false positive reverts honest work.
    _per_detector, combined, _disagreements = evaluate(load_cases(HOLDOUT_SET))
    assert combined.precision >= 0.80, f"held-out precision fell to {combined.precision:.2f}"


# ------------------------------------------------------------------- json mode

def test_json_output_is_parseable(capsys, monkeypatch):
    monkeypatch.setattr("sys.argv", ["eval_claims.py", "--json"])
    assert eval_claims.main() == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["cases"] == 50
    assert set(payload["detectors"]) == set(eval_claims.DETECTORS)


def test_threshold_failure_exits_non_zero(capsys, monkeypatch):
    monkeypatch.setattr(
        "sys.argv",
        ["eval_claims.py", "--set", HOLDOUT_SET, "--min-recall", "0.99"],
    )
    assert eval_claims.main() == 1
