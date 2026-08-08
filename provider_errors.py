"""Typed failure classification for LLM provider calls.

The retry loop used to decide what to do by searching ``str(exc).lower()`` for
substrings like ``"429"`` and ``"unavailable"``. That is fragile across six SDKs:
a vendor rewording an error message silently changes retry behaviour, and a
message that merely mentions a number can be misread.

This module classifies by exception *type* and HTTP status instead. It matches on
class names rather than importing the SDKs, so nothing here forces ``openai``,
``anthropic`` or ``google-genai`` onto the path — the provider modules are
imported lazily inside the router and may legitimately be absent.

String matching survives only as a last resort, for providers that wrap failures
in a bare ``Exception``.
"""

from __future__ import annotations

import random
from enum import StrEnum


class Failure(StrEnum):
    RATE_LIMIT = "rate_limit"
    TRANSIENT = "transient"
    EMPTY_RESPONSE = "empty_response"
    AUTH = "auth"
    BAD_REQUEST = "bad_request"
    UNKNOWN = "unknown"


class EmptyResponseError(RuntimeError):
    """A provider returned success with no usable content.

    Usually a safety filter or a truncated stream. Worth one retry, unlike a
    malformed request, which will fail identically every time.
    """


# Class names are consistent across the OpenAI-style SDKs (openai, anthropic and
# the OpenAI-compatible providers), and cover requests/httpx for the local path.
_CLASS_FAILURE: dict[str, Failure] = {
    # rate limiting
    "RateLimitError": Failure.RATE_LIMIT,
    "ResourceExhausted": Failure.RATE_LIMIT,
    # transient transport / server
    "APITimeoutError": Failure.TRANSIENT,
    "APIConnectionError": Failure.TRANSIENT,
    "InternalServerError": Failure.TRANSIENT,
    "ServiceUnavailableError": Failure.TRANSIENT,
    "ServerError": Failure.TRANSIENT,
    "Timeout": Failure.TRANSIENT,
    "ReadTimeout": Failure.TRANSIENT,
    "ConnectTimeout": Failure.TRANSIENT,
    "ConnectionError": Failure.TRANSIENT,
    "ConnectError": Failure.TRANSIENT,
    "RemoteProtocolError": Failure.TRANSIENT,
    "ChunkedEncodingError": Failure.TRANSIENT,
    # terminal: our request is wrong, or our credentials are
    "AuthenticationError": Failure.AUTH,
    "PermissionDeniedError": Failure.AUTH,
    "BadRequestError": Failure.BAD_REQUEST,
    "InvalidRequestError": Failure.BAD_REQUEST,
    "UnprocessableEntityError": Failure.BAD_REQUEST,
    "NotFoundError": Failure.BAD_REQUEST,
    "ClientError": Failure.BAD_REQUEST,
}

_STATUS_FAILURE: list[tuple[range, Failure]] = [
    (range(429, 430), Failure.RATE_LIMIT),
    (range(401, 404), Failure.AUTH),          # 401, 402, 403
    (range(500, 600), Failure.TRANSIENT),
]

# Last resort only, for providers that raise a bare Exception.
_TEXT_MARKERS: list[tuple[tuple[str, ...], Failure]] = [
    (("429", "too many requests", "quota", "rate limit"), Failure.RATE_LIMIT),
    (
        (
            "500", "502", "503", "504", "unavailable", "timeout", "timed out",
            "internal error", "name resolution", "errno -3", "connection",
            "overloaded",
        ),
        Failure.TRANSIENT,
    ),
    (("401", "403", "api key", "unauthorized", "unauthenticated", "permission"), Failure.AUTH),
]


def _status_code(exc: BaseException) -> int | None:
    code = getattr(exc, "status_code", None)
    if isinstance(code, int):
        return code
    # google-genai puts it on .code; requests puts it on .response.status_code
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code
    response = getattr(exc, "response", None)
    code = getattr(response, "status_code", None)
    if isinstance(code, int):
        return code
    return None


def classify(exc: BaseException) -> Failure:
    """Map a provider exception onto a retry decision.

    Order matters. An explicit HTTP status is the strongest signal, then the
    exception type, then — only if both are absent — the message text.
    """
    if isinstance(exc, EmptyResponseError):
        return Failure.EMPTY_RESPONSE

    status = _status_code(exc)
    if status is not None:
        for span, failure in _STATUS_FAILURE:
            if status in span:
                return failure
        if 400 <= status < 500:
            return Failure.BAD_REQUEST

    for klass in type(exc).__mro__:
        failure = _CLASS_FAILURE.get(klass.__name__)
        if failure is not None:
            return failure

    text = str(exc).lower()
    for markers, failure in _TEXT_MARKERS:
        if any(marker in text for marker in markers):
            return failure

    return Failure.UNKNOWN


def backoff_seconds(failure: Failure, attempt: int) -> float | None:
    """Seconds to wait before retrying, or ``None`` when the failure is terminal.

    ``attempt`` is zero-based. Jitter decorrelates concurrent workers: without it,
    every thread rate-limited at the same instant retries at the same instant and
    reproduces the overload that caused it.
    """
    if failure is Failure.RATE_LIMIT:
        return min(60.0, 4.0 * (2 ** attempt)) + random.uniform(0, 1)
    if failure is Failure.TRANSIENT:
        return min(30.0, 2.0 ** (attempt + 1)) + random.uniform(0, 1)
    if failure is Failure.EMPTY_RESPONSE:
        # One retry only: a safety block is rarely cleared by asking again.
        return 2.0 + random.uniform(0, 1) if attempt == 0 else None
    # AUTH and BAD_REQUEST will fail identically however many times we ask.
    return None


def is_retryable(exc: BaseException, attempt: int) -> tuple[bool, Failure, float]:
    """Convenience wrapper: ``(should_retry, classification, delay_seconds)``."""
    failure = classify(exc)
    delay = backoff_seconds(failure, attempt)
    return delay is not None, failure, delay or 0.0
