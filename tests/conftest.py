import pytest

import analyser
import job_fit


@pytest.fixture(autouse=True)
def _fresh_jd_cache():
    """The job description read is cached per process; a test must not see another's."""
    job_fit.reset_cache()
    yield
    job_fit.reset_cache()


@pytest.fixture(autouse=True)
def _no_live_model_calls(monkeypatch):
    """Every model call in the suite is stubbed. One that isn't would depend on
    whatever key is in .env and quietly hit a real provider."""
    def live(*args, **kwargs):
        raise RuntimeError("a test reached a live model call, stub llm_call")

    for module in (analyser, job_fit):
        monkeypatch.setattr(module, "llm_call", live)
