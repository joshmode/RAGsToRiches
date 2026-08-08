"""Prompt version gate.

A prompt edit is a code change with no type system to catch it: the code still
runs, the JSON still parses, and output quality moves silently. These pinned
hashes make that change visible in review.

If this test fails you have edited a prompt. That is fine — it is not a bug — but
before updating the pin below:

  1. re-run the detector eval (``python eval_claims.py``) so the change is measured
     rather than assumed;
  2. note the before/after numbers in the pull request.

Then paste the new hashes here.
"""

import analyser  # noqa: F401  (imported for its side effect: prompt registration)
from prompt_registry import prompt_set_version, prompt_versions, register, version_of

import pytest


PINNED = {
    "numeric_critic": "e39ae81a05f6",
    "qualitative_system": "a266313b9846",
    "result_schema": "83a5e99a5993",
    "rewrite_system": "90c8d6c10015",
    "severity_guide": "3f6d2410f55e",
}

PINNED_SET_VERSION = "0a15ad4b7351"


def test_every_pipeline_prompt_is_registered():
    assert set(prompt_versions()) == set(PINNED)


def test_prompt_versions_match_the_pin():
    current = prompt_versions()
    drifted = {
        name: (PINNED[name], current[name])
        for name in PINNED
        if current.get(name) != PINNED[name]
    }
    assert not drifted, (
        "A registered prompt changed. Re-run the detector eval, record the "
        f"before/after in the PR, then update PINNED. Drift: {drifted}"
    )


def test_prompt_set_version_matches_the_pin():
    assert prompt_set_version() == PINNED_SET_VERSION


@pytest.fixture
def isolated_registry():
    """Restore the registry afterwards.

    Without this, a test that registers a probe prompt permanently changes the
    set version and the pin tests fail depending on execution order.
    """
    import prompt_registry
    snapshot = dict(prompt_registry._PROMPTS)
    try:
        yield
    finally:
        prompt_registry._PROMPTS.clear()
        prompt_registry._PROMPTS.update(snapshot)


def test_set_version_changes_when_any_prompt_changes(isolated_registry):
    before = prompt_set_version()
    register("__probe__", "a prompt that did not exist before")
    assert prompt_set_version() != before


def test_set_version_is_restored_after_isolation():
    # Guards the fixture itself: the pin must still hold once probes are undone.
    assert prompt_set_version() == PINNED_SET_VERSION


def test_registering_the_same_name_with_new_text_is_rejected(isolated_registry):
    register("__stable__", "one")
    with pytest.raises(ValueError):
        register("__stable__", "two")


def test_registering_identical_text_twice_is_fine(isolated_registry):
    register("__idempotent__", "same")
    register("__idempotent__", "same")
    assert version_of("__idempotent__")


def test_unregistered_name_raises():
    with pytest.raises(KeyError):
        version_of("__never_registered__")
