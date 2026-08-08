"""Tests for the SSE analysis endpoint on the Flask engine.

The analyser itself is stubbed: what is under test is the transport — that stage
events reach the client in order, that the final result arrives, that a failure
becomes an event rather than a hung connection, and that the existing JSON
endpoint is untouched.
"""

import json

import pytest

import engine_api


@pytest.fixture
def client():
    engine_api.app.config["TESTING"] = True
    with engine_api.app.test_client() as test_client:
        yield test_client


def _frames(response):
    """Parse an SSE body into a list of decoded event payloads."""
    body = response.get_data(as_text=True)
    events = []
    for block in body.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        assert block.startswith("data: "), f"malformed SSE frame: {block!r}"
        events.append(json.loads(block[len("data: "):]))
    return events


PAYLOAD = {
    "resume_json": {"raw_text": "x", "sections": {"EXPERIENCE": ["Helped with X"]}},
    "job_description": "python",
    "provider": "gemini",
}


def test_stream_emits_progress_then_a_final_result(client, monkeypatch):
    def fake_analyse(**kwargs):
        emit = kwargs["progress"]
        emit({"stage": "started"})
        emit({"stage": "rewriting", "chunks": 2, "bullets": 8, "workers": 2})
        emit({"stage": "chunk", "completed": 1, "total": 2, "rewrites": []})
        emit({"stage": "chunk", "completed": 2, "total": 2, "rewrites": []})
        return {"score": {"total": 71}, "rewrites": {}}

    monkeypatch.setattr(engine_api, "analyse", fake_analyse)
    response = client.post("/analyse-stream", json=PAYLOAD)

    assert response.status_code == 200
    assert response.mimetype == "text/event-stream"
    events = _frames(response)
    assert [e["stage"] for e in events] == [
        "started", "rewriting", "chunk", "chunk", "done",
    ]
    assert events[-1]["result"]["score"]["total"] == 71


def test_chunk_events_carry_their_rewrites(client, monkeypatch):
    def fake_analyse(**kwargs):
        kwargs["progress"]({
            "stage": "chunk", "completed": 1, "total": 1,
            "rewrites": [{"original": "Helped with X", "rewritten": "Led X"}],
        })
        return {"score": {"total": 50}}

    monkeypatch.setattr(engine_api, "analyse", fake_analyse)
    events = _frames(client.post("/analyse-stream", json=PAYLOAD))
    chunk = next(e for e in events if e["stage"] == "chunk")
    assert chunk["rewrites"][0]["rewritten"] == "Led X"


def test_failure_becomes_an_error_event_not_a_hang(client, monkeypatch):
    def boom(**kwargs):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(engine_api, "analyse", boom)
    events = _frames(client.post("/analyse-stream", json=PAYLOAD))
    assert events[-1]["stage"] == "error"
    # The internal message must not be reflected to the client.
    assert "exploded" not in json.dumps(events[-1])


def test_stream_sets_no_buffering_headers(client, monkeypatch):
    monkeypatch.setattr(engine_api, "analyse", lambda **kwargs: {"score": {}})
    response = client.post("/analyse-stream", json=PAYLOAD)
    assert response.headers["Cache-Control"] == "no-cache"
    assert response.headers["X-Accel-Buffering"] == "no"


def test_stream_survives_an_empty_body(client, monkeypatch):
    monkeypatch.setattr(engine_api, "analyse", lambda **kwargs: {"score": {}})
    response = client.post("/analyse-stream", json={})
    assert response.status_code == 200
    assert _frames(response)[-1]["stage"] == "done"


def test_internal_object_is_stripped_from_the_streamed_result(client, monkeypatch):
    monkeypatch.setattr(
        engine_api, "analyse",
        lambda **kwargs: {"score": {}, "parsed_resume_obj": object()},
    )
    events = _frames(client.post("/analyse-stream", json=PAYLOAD))
    assert "parsed_resume_obj" not in events[-1]["result"]


def test_existing_json_endpoint_is_unchanged(client, monkeypatch):
    seen = {}

    def fake_analyse(**kwargs):
        seen.update(kwargs)
        return {"score": {"total": 60}}

    monkeypatch.setattr(engine_api, "analyse", fake_analyse)
    response = client.post("/analyse", json=PAYLOAD)
    assert response.status_code == 200
    assert response.get_json()["score"]["total"] == 60
    # The non-streaming path must not have acquired a progress callback.
    assert "progress" not in seen


def test_health_still_responds(client):
    assert client.get("/health").get_json() == {"status": "ok"}
