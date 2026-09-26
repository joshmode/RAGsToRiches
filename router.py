import os
import time
import threading
import ipaddress
import socket
import contextvars
from contextlib import contextmanager
from urllib.parse import urlparse
import requests

from provider_errors import EmptyResponseError, backoff_seconds, classify


_PLACEHOLDER_VALS = {
    "your_key", "changeme", "change_me", "xxx", "sk-xxx",
    "put_your_key_here", "replace_me", "your_api_key",
    "insert_key_here", "placeholder",
}

# "default" resolves to openrouter 
_PROVIDER_LIMITS = {
    "gemini":     int(os.environ.get("GEMINI_MAX_CONCURRENCY", "4")),
    "claude":     int(os.environ.get("CLAUDE_MAX_CONCURRENCY", "3")),
    "chatgpt":    int(os.environ.get("OPENAI_MAX_CONCURRENCY", "4")),
    "openrouter": int(os.environ.get("OPENROUTER_MAX_CONCURRENCY", "6")),
    "groq":       int(os.environ.get("GROQ_MAX_CONCURRENCY", "6")),
    "local":      int(os.environ.get("LOCAL_MAX_CONCURRENCY", "2")),
    # offline recorded answers, see replay.py
    "replay":     int(os.environ.get("REPLAY_MAX_CONCURRENCY", "8")),
}
_PROVIDER_LOCKS = {
    provider: threading.BoundedSemaphore(max(limit, 1))
    for provider, limit in _PROVIDER_LIMITS.items()
}

# env-overridable since exact model IDs drift, check these against current provider docs
_DEFAULT_MODELS = {
    "gemini":     os.environ.get("GEMINI_DEFAULT_MODEL", "gemini-3.5-flash"),
    "claude":     os.environ.get("CLAUDE_DEFAULT_MODEL", "claude-sonnet-5"),
    "chatgpt":    os.environ.get("OPENAI_DEFAULT_MODEL", "gpt-4o"),
    "openrouter": os.environ.get("OPENROUTER_DEFAULT_MODEL", "nvidia/nemotron-3-ultra-550b-a55b:free"),
    "groq":       os.environ.get("GROQ_DEFAULT_MODEL", "qwen/qwen3.6-27b"),
    "local":      os.environ.get("LOCAL_DEFAULT_MODEL", "llama3"),
    "replay":     "replay",
}

# if a pinned free-tier model gets pulled (as qwen did lol) fall back
_FALLBACK_MODELS = {
    "openrouter": os.environ.get("OPENROUTER_FALLBACK_MODEL", "openrouter/free"),
}

# the critic answers PASS or FAIL, a smaller model does that fine for a fraction of the cost
_CRITIC_MODELS = {
    "claude": os.environ.get("CLAUDE_CRITIC_MODEL", "claude-haiku-4-5"),
}


def resolve_model(provider: str, model: str = "") -> str:
    return model or _DEFAULT_MODELS.get(provider.lower(), "")


def default_critic_model(provider: str) -> str:
    """"" means the critic runs on the main model."""
    return _CRITIC_MODELS.get(provider.lower(), "")


# the models that actually answered during an analysis, fallbacks included, so a
# stored result can say what produced it
_models_used: contextvars.ContextVar[set | None] = contextvars.ContextVar("llm_models_used", default=None)


@contextmanager
def record_models():
    used: set[str] = set()
    token = _models_used.set(used)
    try:
        yield used
    finally:
        _models_used.reset(token)


def _note_model(model: str) -> None:
    used = _models_used.get()
    if used is not None:
        used.add(model)


# One analysis gets one time budget. The SDKs retry on their own, the loop below
# retries, and openrouter has a fallback model. Stacked, a single failing call
# could outlast the client's own ten minute limit. Every attempt now has to fit
# in what's left of the budget, and nothing starts once it's spent.
_deadline: contextvars.ContextVar[float | None] = contextvars.ContextVar("llm_deadline", default=None)


class DeadlineExceeded(TimeoutError):
    """The analysis ran out of time, so no further model call is worth starting."""


@contextmanager
def deadline(seconds: float):
    """Bound every llm_call inside the block, retries and fallbacks included."""
    token = _deadline.set(time.monotonic() + seconds)
    try:
        yield
    finally:
        _deadline.reset(token)


def time_left() -> float | None:
    end = _deadline.get()
    return None if end is None else end - time.monotonic()


def submit(pool, fn, *args, **kwargs):
    """pool.submit that carries the deadline into the worker thread. A thread pool
    doesn't copy context variables on its own."""
    return pool.submit(contextvars.copy_context().run, fn, *args, **kwargs)


def _is_key_placeholder(value: str) -> bool:
    cleaned = (value or "").strip()
    if len(cleaned) < 8:
        return True
    lowered = cleaned.lower()
    if lowered in _PLACEHOLDER_VALS:
        return True
    return (
        "your" in lowered and "key" in lowered
        or "replace" in lowered and "key" in lowered
        or lowered.startswith("<") and lowered.endswith(">")
    )


def _default_local_endpoint() -> str:
    if os.path.exists("/.dockerenv") or os.environ.get("DOCKER_CONTAINER"):
        return "http://host.docker.internal:11434/api/chat"
    return "http://localhost:11434/api/chat"


def _is_local_endpoint(url: str) -> bool:
    """local ollama (loopback/private) and tunneled ollama (public, for hosted deployments) are
    both legitimate here - only block link-local/metadata-service targets like cloud instance
    metadata endpoints, which have no business being an LLM endpoint either way"""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False
        host = parsed.hostname
        if host == "host.docker.internal":
            return True
        for entry in socket.getaddrinfo(host, None):
            addr = ipaddress.ip_address(entry[4][0])
            if addr.is_link_local or addr.is_multicast or addr.is_unspecified or addr.is_reserved:
                return False
        return True
    except Exception:
        return False


def _resolve_key(provider: str, env_var: str, api_key: str) -> str:
    """caller-supplied key wins over the pooled env var, keeps concurrent users isolated"""
    key = (api_key or "").strip() or os.environ.get(env_var, "")
    if not key or _is_key_placeholder(key):
        raise EnvironmentError(f"No {provider} API key available. Add your own key, or use Default (Free).")
    return key


def llm_call(
    user_prompt: str,
    system_prompt: str = "",
    provider: str = "gemini",
    model: str = "",
    max_tokens: int = 1024,
    local_endpoint: str = "",
    max_retries: int = 5,
    timeout: int = 120,
    api_key: str = "",
) -> str:
    provider = provider.lower()

    if not local_endpoint:
        local_endpoint = _default_local_endpoint()

    if provider not in _PROVIDER_LOCKS:
        raise ValueError(f"Unsupported LLM provider: {provider}")

    resolved_model = model or _DEFAULT_MODELS[provider]
    try:
        answer = _dispatch(provider, user_prompt, system_prompt, resolved_model,
                           max_tokens, local_endpoint, max_retries, timeout, api_key)
        _note_model(resolved_model)
        return answer
    except Exception as primary_err:
        fallback_model = _FALLBACK_MODELS.get(provider, "")
        if not fallback_model or fallback_model == resolved_model:
            raise
        left = time_left()
        if isinstance(primary_err, DeadlineExceeded) or (left is not None and left < 5):
            raise
        print(f"{provider} call failed on '{resolved_model}' after {max_retries} attempt(s), "
              f"falling back to '{fallback_model}': {primary_err}")
        answer = _dispatch(provider, user_prompt, system_prompt, fallback_model,
                           max_tokens, local_endpoint, max_retries, timeout, api_key)
        _note_model(fallback_model)
        return answer


def _dispatch(
    provider: str,
    user_prompt: str,
    system_prompt: str,
    model: str,
    max_tokens: int,
    local_endpoint: str,
    max_retries: int,
    timeout: int,
    api_key: str,
) -> str:
    """one model, with its own retry loop for transient errors - no fallback here, llm_call orchestrates that"""
    last_err = None

    for attempt in range(max_retries):
        left = time_left()
        if left is not None and left <= 1:
            if last_err is not None:
                break
            raise DeadlineExceeded("The analysis ran out of time before this call could start.")
        call_timeout = timeout if left is None else max(1.0, min(timeout, left))
        try:
            with _PROVIDER_LOCKS[provider]:
                if provider == "gemini":
                    from google import genai
                    from google.genai import types

                    key = _resolve_key("Gemini", "GEMINI_API_KEY", api_key)
                    client = genai.Client(
                        api_key=key,
                        http_options=types.HttpOptions(
                            timeout=int(call_timeout * 1000),
                            # this loop does the retrying
                            retry_options=types.HttpRetryOptions(attempts=1),
                        ),
                    )
                    mdl = model

                    cfg_kw = {"max_output_tokens": max_tokens}
                    if system_prompt: cfg_kw["system_instruction"] = system_prompt

                    if "gemma" not in mdl.lower():
                        cfg_kw["safety_settings"] = [
                            types.SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="BLOCK_ONLY_HIGH"),
                            types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="BLOCK_ONLY_HIGH"),
                            types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_ONLY_HIGH"),
                            types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_ONLY_HIGH"),
                        ]
                        if "json" in system_prompt.lower() or "json" in user_prompt.lower():
                            cfg_kw["response_mime_type"] = "application/json"

                    cfg = types.GenerateContentConfig(**cfg_kw)
                    resp = client.models.generate_content(model=mdl, contents=user_prompt, config=cfg)
                    if resp.text is None: raise EmptyResponseError("Gemini returned no content (likely a safety block).")
                    return resp.text

                elif provider == "claude":
                    import anthropic
                    key = _resolve_key("Claude", "ANTHROPIC_API_KEY", api_key)
                    mdl = model
                    client = anthropic.Anthropic(api_key=key, timeout=call_timeout, max_retries=0)
                    msg = client.messages.create(
                        model=mdl,
                        max_tokens=max_tokens,
                        system=system_prompt,
                        messages=[{"role": "user", "content": user_prompt}]
                    )
                    # models that think first put a thinking block ahead of the answer
                    text = "".join(block.text for block in msg.content if getattr(block, "type", "") == "text")
                    if not text: raise EmptyResponseError("Claude returned no content.")
                    return text

                elif provider == "chatgpt":
                    import openai
                    key = _resolve_key("ChatGPT", "OPENAI_API_KEY", api_key)
                    mdl = model
                    client = openai.OpenAI(api_key=key, timeout=call_timeout, max_retries=0)
                    res = client.chat.completions.create(
                        model=mdl,
                        max_tokens=max_tokens,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt}
                        ]
                    )
                    if res.choices[0].message.content is None: raise EmptyResponseError("ChatGPT returned no content.")
                    return res.choices[0].message.content

                elif provider == "openrouter":
                    # openrouter's api is openai-compatible, reuse the sdk with a different base_url
                    import openai
                    key = _resolve_key("OpenRouter", "OPENROUTER_API_KEY", api_key)
                    mdl = model
                    client = openai.OpenAI(api_key=key, base_url="https://openrouter.ai/api/v1", timeout=call_timeout, max_retries=0)
                    res = client.chat.completions.create(
                        model=mdl,
                        max_tokens=max_tokens,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt}
                        ]
                    )
                    if res.choices[0].message.content is None: raise EmptyResponseError("OpenRouter returned no content.")
                    return res.choices[0].message.content

                elif provider == "groq":
                    # kept working but unused by default
                    import openai
                    key = _resolve_key("Groq", "GROQ_API_KEY", api_key)
                    mdl = model
                    client = openai.OpenAI(api_key=key, base_url="https://api.groq.com/openai/v1", timeout=call_timeout, max_retries=0)
                    res = client.chat.completions.create(
                        model=mdl,
                        max_tokens=max_tokens,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt}
                        ]
                    )
                    if res.choices[0].message.content is None: raise EmptyResponseError("Groq returned no content.")
                    return res.choices[0].message.content

                elif provider == "replay":
                    # no key and no network: the demo and the end-to-end tests
                    import replay
                    text = replay.answer(user_prompt, system_prompt)
                    if not text: raise EmptyResponseError("The replay provider has no answer for this prompt.")
                    return text

                elif provider == "local":
                    if not _is_local_endpoint(local_endpoint):
                        raise ValueError("Local endpoint isn't allowed (blocked internal/metadata address).")
                    mdl = model
                    payload = {
                        "model": mdl,
                        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                        "stream": False,
                        "options": {"num_predict": max_tokens}
                    }
                    res = requests.post(local_endpoint, json=payload, timeout=call_timeout)
                    res.raise_for_status()
                    content = res.json().get("message", {}).get("content")
                    if content is None: raise EmptyResponseError("Local model returned no content.")
                    return content


        except Exception as e:
            last_err = e
            failure = classify(e)
            delay = backoff_seconds(failure, attempt) if attempt < max_retries - 1 else None
            left = time_left()
            if delay is not None and left is not None and delay >= left - 1:
                # no time to wait and try again inside the analysis budget
                delay = None
            if delay is None:
                # Terminal, or out of attempts. Retrying a bad key or a malformed
                # request just burns latency for an identical failure.
                break
            print(
                f"{provider} call failed ({failure}), retrying in {delay:.1f}s "
                f"(attempt {attempt + 1}/{max_retries}): {e}"
            )
            time.sleep(delay)
            continue

    raise last_err
