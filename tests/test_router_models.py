"""Model IDs, answer parsing and the record of which model produced a result."""

import os
import sys
import types

import pytest

import analyser
import router
from provider_errors import EmptyResponseError
from test_router_deadline import KEY, BadRequestError, _fake_openai, _reply

SimpleNamespace = types.SimpleNamespace


def _fake_anthropic(monkeypatch, content):
    built = []

    class _Messages:
        def create(self, **kwargs):
            built[-1]["request"] = kwargs
            return SimpleNamespace(content=content, stop_reason="end_turn")

    class Anthropic:
        def __init__(self, **kwargs):
            built.append({"client": kwargs})
            self.messages = _Messages()

    module = types.ModuleType("anthropic")
    module.Anthropic = Anthropic
    monkeypatch.setitem(sys.modules, "anthropic", module)
    return built


def test_the_claude_default_is_a_real_model_id():
    assert router._DEFAULT_MODELS["claude"] == os.environ.get("CLAUDE_DEFAULT_MODEL", "claude-sonnet-5")


def test_a_claude_answer_skips_the_thinking_block(monkeypatch):
    built = _fake_anthropic(monkeypatch, [
        SimpleNamespace(type="thinking", thinking=""),
        SimpleNamespace(type="text", text="PASS: supported"),
    ])
    assert router.llm_call("hi", provider="claude", api_key=KEY) == "PASS: supported"
    assert built[0]["client"]["max_retries"] == 0
    assert built[0]["request"]["model"] == router.resolve_model("claude")


def test_a_claude_answer_with_no_text_is_empty(monkeypatch):
    _fake_anthropic(monkeypatch, [SimpleNamespace(type="thinking", thinking="")])
    with pytest.raises(EmptyResponseError):
        router.llm_call("hi", provider="claude", api_key=KEY, max_retries=1)


def test_the_claude_critic_runs_on_the_smaller_model(monkeypatch):
    monkeypatch.setenv("CRITIC_SAME_AS_MAIN", "true")
    monkeypatch.delenv("CRITIC_MODEL", raising=False)
    critic_model = analyser._critic_creds("claude", router.resolve_model("claude"), KEY, "")[1]
    assert critic_model == router.default_critic_model("claude")
    assert critic_model and critic_model != router.resolve_model("claude")
    # other providers keep the main model
    assert analyser._critic_creds("gemini", "", KEY, "")[1] == ""


def test_the_answering_model_is_recorded(monkeypatch):
    _fake_openai(monkeypatch, lambda kwargs: _reply("ok"))
    with router.record_models() as used:
        router.llm_call("hi", provider="chatgpt", api_key=KEY)
    assert used == {router.resolve_model("chatgpt")}


def test_a_fallback_model_is_recorded_as_what_answered(monkeypatch):
    def first_fails(kwargs):
        if kwargs["model"] == router.resolve_model("openrouter"):
            raise BadRequestError("model pulled")
        return _reply("ok")

    _fake_openai(monkeypatch, first_fails)
    with router.record_models() as used:
        router.llm_call("hi", provider="openrouter", api_key=KEY)
    assert used == {router._FALLBACK_MODELS["openrouter"]}


def test_an_analysis_names_its_model(monkeypatch):
    monkeypatch.setattr(analyser, "llm_call", lambda *a, **k: '{"rewritten": "Rewrote it", "severity": "yellow"}')
    monkeypatch.setattr(analyser, "query_fw", lambda text, n_results=3: [])
    resume = analyser.ParsedResume()
    resume.sections = {"EXPERIENCE": ["- Worked on the checkout system with the payments team"]}
    result = analyser.analyse(resume=resume, job_description="", provider="gemini")
    # the stub never reaches the router, so the configured model stands in
    assert result["model"] == router.resolve_model("gemini")
