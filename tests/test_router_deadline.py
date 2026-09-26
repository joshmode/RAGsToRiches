"""Retries can't stack past the time an analysis is allowed.

The SDKs retried twice on their own, under the router's five attempts, under
openrouter's fallback model, each attempt with a 120 second timeout. One failing
call could run longer than the client waits. The SDK retries are now off and
every attempt has to fit in what's left of the analysis deadline.

No SDK is installed for the suite, so a fake ``openai`` module stands in.
"""

import json
import sys
import types

import pytest

import analyser
import router
from parser import ParsedResume

KEY = "sk-test-key-0123456789"


class _Clock:
    """Router time only: sleeping advances the clock instead of waiting."""

    def __init__(self):
        self.now = 1000.0
        self.slept = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        self.slept += seconds


@pytest.fixture
def clock(monkeypatch):
    fake = _Clock()
    monkeypatch.setattr(router, "time", types.SimpleNamespace(monotonic=fake.monotonic, sleep=fake.sleep))
    return fake


class APIConnectionError(Exception):
    pass


class BadRequestError(Exception):
    pass


def _fake_openai(monkeypatch, answer):
    """Install an ``openai`` module whose client records how it was built."""
    built = []

    class _Completions:
        def create(self, **kwargs):
            return answer(kwargs)

    class OpenAI:
        def __init__(self, **kwargs):
            built.append(kwargs)
            self.chat = types.SimpleNamespace(completions=_Completions())

    module = types.ModuleType("openai")
    module.OpenAI = OpenAI
    monkeypatch.setitem(sys.modules, "openai", module)
    return built


def _reply(text):
    message = types.SimpleNamespace(content=text)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])


def test_sdk_retries_are_off(monkeypatch):
    built = _fake_openai(monkeypatch, lambda kwargs: _reply("ok"))
    assert router.llm_call("hi", provider="chatgpt", api_key=KEY) == "ok"
    assert built[0]["max_retries"] == 0


def test_each_attempt_fits_in_the_deadline(monkeypatch, clock):
    built = _fake_openai(monkeypatch, lambda kwargs: _reply("ok"))
    with router.deadline(10):
        router.llm_call("hi", provider="chatgpt", api_key=KEY, timeout=120)
    assert built[0]["timeout"] <= 10


def test_retries_stop_at_the_deadline(monkeypatch, clock):
    def down(kwargs):
        raise APIConnectionError("connection reset")

    built = _fake_openai(monkeypatch, down)
    with router.deadline(20), pytest.raises(APIConnectionError):
        router.llm_call("hi", provider="chatgpt", api_key=KEY)
    assert clock.slept <= 20
    assert len(built) < 5


def test_without_a_deadline_the_retries_run_their_course(monkeypatch, clock):
    def down(kwargs):
        raise APIConnectionError("connection reset")

    built = _fake_openai(monkeypatch, down)
    with pytest.raises(APIConnectionError):
        router.llm_call("hi", provider="chatgpt", api_key=KEY)
    assert len(built) == 5


def test_nothing_starts_once_the_time_is_spent(monkeypatch, clock):
    built = _fake_openai(monkeypatch, lambda kwargs: _reply("ok"))
    with router.deadline(5):
        clock.now += 10
        with pytest.raises(router.DeadlineExceeded):
            router.llm_call("hi", provider="chatgpt", api_key=KEY)
    assert built == []


def test_the_fallback_model_is_skipped_when_time_is_short(monkeypatch, clock):
    def rejected(kwargs):
        raise BadRequestError("model pulled")

    built = _fake_openai(monkeypatch, rejected)
    with router.deadline(3), pytest.raises(BadRequestError):
        router.llm_call("hi", provider="openrouter", api_key=KEY)
    assert len(built) == 1


def test_the_fallback_model_still_runs_with_time_to_spare(monkeypatch, clock):
    def rejected(kwargs):
        raise BadRequestError("model pulled")

    built = _fake_openai(monkeypatch, rejected)
    with router.deadline(60), pytest.raises(BadRequestError):
        router.llm_call("hi", provider="openrouter", api_key=KEY)
    assert len(built) == 2


# ------------------------------------------------------------ in the pipeline

def _resume():
    resume = ParsedResume()
    resume.raw_text = "x"
    resume.sections = {"EXPERIENCE": [
        "- Worked on the checkout system with the payments team",
        "- Helped with the migration of legacy billing services",
    ]}
    return resume


def test_the_deadline_reaches_the_worker_threads(monkeypatch):
    seen = []

    def fake(user_prompt="", **kwargs):
        seen.append(router.time_left())
        count = user_prompt.count("\n[") if "BULLETS TO REWRITE" in user_prompt else 0
        if count:
            return json.dumps([{"index": i, "rewritten": "Rewrote it", "severity": "yellow"} for i in range(count)])
        return json.dumps({"rewritten": "Rewrote it", "severity": "yellow"})

    monkeypatch.setattr(analyser, "llm_call", fake)
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=3: [])
    analyser.analyse(resume=_resume(), job_description="", provider="gemini")
    assert seen and all(left is not None and left > 0 for left in seen)


def test_out_of_time_bullets_are_skipped_and_counted(monkeypatch):
    calls = []

    def expired(user_prompt="", **kwargs):
        calls.append(user_prompt)
        raise router.DeadlineExceeded("spent")

    monkeypatch.setattr(analyser, "llm_call", expired)
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=3: [])
    result = analyser.analyse(resume=_resume(), job_description="", provider="gemini")
    assert len(calls) == 1  # no per-bullet fallback once the time is gone
    assert result["rewrite_skipped"] == 2
    item = result["rewrites"]["EXPERIENCE"][0]
    assert item["reasoning"] == "Rewrite skipped: the analysis ran out of time."
