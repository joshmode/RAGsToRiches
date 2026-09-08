"""Content-addressed versions for the prompts that drive the rewrite pipeline.

A prompt edit is a code change that no type checker and no unit test will catch:
the code still runs, the JSON still parses, and the output quality silently moves.
Nothing records which wording produced a given analysis, so a quality regression
cannot be traced back to the change that caused it.

Every prompt is therefore registered here and versioned by the hash of its own
text. Two things follow:

* ``prompt_versions()`` is recorded on each analysis, so a stored result names the
  exact wording that produced it.
* ``tests/test_prompt_versions.py`` pins the current hashes, so editing a prompt
  fails the build until someone acknowledges the change and re-runs the eval.
"""

from __future__ import annotations

import hashlib

_VERSION_LENGTH = 12

_PROMPTS: dict[str, str] = {}


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:_VERSION_LENGTH]


def register(name: str, text: str) -> str:
    """Register a prompt and return it unchanged, so it can wrap an assignment.

    Re-registering the same name with different text is a programming error: two
    prompts sharing a name would make the recorded version ambiguous.
    """
    existing = _PROMPTS.get(name)
    if existing is not None and existing != text:
        raise ValueError(f"prompt {name!r} is already registered with different text")
    _PROMPTS[name] = text
    return text


def version_of(name: str) -> str:
    """The version of one registered prompt."""
    if name not in _PROMPTS:
        raise KeyError(f"prompt {name!r} is not registered")
    return _digest(_PROMPTS[name])


def prompt_versions() -> dict[str, str]:
    """Every registered prompt name mapped to its content version."""
    return {name: _digest(text) for name, text in sorted(_PROMPTS.items())}


def prompt_set_version() -> str:
    """One version covering the whole prompt set.

    Changing any registered prompt changes this, which makes it a usable cache key
    and a usable label for an eval run.
    """
    joined = "\n".join(f"{name}:{_digest(text)}" for name, text in sorted(_PROMPTS.items()))
    return _digest(joined)


def registered_names() -> list[str]:
    return sorted(_PROMPTS)
