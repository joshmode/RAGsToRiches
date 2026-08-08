"""Tests for typed provider failure classification.

The point of this module is that a vendor rewording an error message must not
change retry behaviour, so most of these assert on exception *type* and HTTP
status rather than on text.
"""

import pytest

from provider_errors import (
    EmptyResponseError,
    Failure,
    backoff_seconds,
    classify,
    is_retryable,
)


# Stand-ins shaped like the real SDK exceptions. The classifier matches on class
# name and status attributes, so it never needs the SDKs installed.
class RateLimitError(Exception):
    pass


class APITimeoutError(Exception):
    pass


class APIConnectionError(Exception):
    pass


class AuthenticationError(Exception):
    pass


class BadRequestError(Exception):
    pass


class InternalServerError(Exception):
    pass


class NotFoundError(Exception):
    pass


class _WithStatus(Exception):
    def __init__(self, status_code):
        super().__init__(f"http {status_code}")
        self.status_code = status_code


class _WithResponse(Exception):
    class _R:
        def __init__(self, code):
            self.status_code = code

    def __init__(self, code):
        super().__init__("requests-style failure")
        self.response = self._R(code)


# ------------------------------------------------------------- classification

@pytest.mark.parametrize("exc, expected", [
    (RateLimitError("slow down"), Failure.RATE_LIMIT),
    (APITimeoutError("timed out"), Failure.TRANSIENT),
    (APIConnectionError("no route"), Failure.TRANSIENT),
    (InternalServerError("boom"), Failure.TRANSIENT),
    (AuthenticationError("bad key"), Failure.AUTH),
    (BadRequestError("malformed"), Failure.BAD_REQUEST),
    (NotFoundError("no such model"), Failure.BAD_REQUEST),
    (EmptyResponseError("safety block"), Failure.EMPTY_RESPONSE),
])
def test_classifies_by_exception_type(exc, expected):
    assert classify(exc) is expected


@pytest.mark.parametrize("status, expected", [
    (429, Failure.RATE_LIMIT),
    (401, Failure.AUTH),
    (403, Failure.AUTH),
    (400, Failure.BAD_REQUEST),
    (404, Failure.BAD_REQUEST),
    (422, Failure.BAD_REQUEST),
    (500, Failure.TRANSIENT),
    (503, Failure.TRANSIENT),
])
def test_status_code_attribute_drives_classification(status, expected):
    assert classify(_WithStatus(status)) is expected


def test_requests_style_nested_response_status_is_read():
    assert classify(_WithResponse(429)) is Failure.RATE_LIMIT
    assert classify(_WithResponse(503)) is Failure.TRANSIENT


def test_status_wins_over_a_misleading_message():
    # The old string matcher would have read "connection" and retried forever.
    exc = _WithStatus(401)
    exc.args = ("connection to the model was unavailable",)
    assert classify(exc) is Failure.AUTH


def test_text_fallback_only_when_nothing_typed_is_available():
    assert classify(Exception("HTTP 429 Too Many Requests")) is Failure.RATE_LIMIT
    assert classify(Exception("upstream connection reset")) is Failure.TRANSIENT
    assert classify(Exception("invalid api key supplied")) is Failure.AUTH


def test_unrecognised_failure_is_unknown():
    assert classify(Exception("something entirely novel")) is Failure.UNKNOWN


def test_subclass_of_a_known_error_is_still_classified():
    class VendorRateLimitError(RateLimitError):
        pass
    assert classify(VendorRateLimitError("nope")) is Failure.RATE_LIMIT


# -------------------------------------------------------------------- backoff

def test_rate_limit_backoff_grows_and_is_capped():
    first = backoff_seconds(Failure.RATE_LIMIT, 0)
    later = backoff_seconds(Failure.RATE_LIMIT, 2)
    assert 4.0 <= first <= 5.0
    assert 16.0 <= later <= 17.0
    assert backoff_seconds(Failure.RATE_LIMIT, 20) <= 61.0


def test_transient_backoff_is_shorter_than_rate_limit():
    assert backoff_seconds(Failure.TRANSIENT, 0) < backoff_seconds(Failure.RATE_LIMIT, 0)
    assert backoff_seconds(Failure.TRANSIENT, 20) <= 31.0


def test_empty_response_is_retried_once_only():
    assert backoff_seconds(Failure.EMPTY_RESPONSE, 0) is not None
    assert backoff_seconds(Failure.EMPTY_RESPONSE, 1) is None


@pytest.mark.parametrize("failure", [Failure.AUTH, Failure.BAD_REQUEST, Failure.UNKNOWN])
def test_terminal_failures_are_never_retried(failure):
    assert backoff_seconds(failure, 0) is None


def test_backoff_includes_jitter():
    # Two draws should differ; identical delays would resynchronise every worker.
    draws = {backoff_seconds(Failure.RATE_LIMIT, 0) for _ in range(20)}
    assert len(draws) > 1


def test_is_retryable_wrapper():
    retry, failure, delay = is_retryable(RateLimitError("slow down"), 0)
    assert retry is True and failure is Failure.RATE_LIMIT and delay > 0

    retry, failure, delay = is_retryable(AuthenticationError("bad key"), 0)
    assert retry is False and failure is Failure.AUTH and delay == 0.0
