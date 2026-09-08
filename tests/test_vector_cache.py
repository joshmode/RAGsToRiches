"""Tests for the two-layer framework-retrieval cache.

ChromaDB is not required: the collection and the embedder are both stubbed, so
these exercise the cache logic itself rather than the vector store.
"""

import time

import pytest

import vector_db
from vector_db import FwHit


class _FakeCollection:
    """Counts queries so a cache hit is observable."""

    def __init__(self, size=8):
        self.queries = 0
        self._size = size

    def count(self):
        return self._size

    def query(self, query_texts, n_results, include):
        self.queries += 1
        return {
            "documents": [["framework doc"] * n_results],
            "metadatas": [[{"framework": "STAR", "category": "structure"}] * n_results],
            "distances": [[0.1] * n_results],
        }


@pytest.fixture
def wired(monkeypatch):
    """A fresh cache with a stub collection and a deterministic embedder."""
    vector_db.reset_cache()
    collection = _FakeCollection()
    monkeypatch.setattr(vector_db, "_get_col", lambda: collection)
    monkeypatch.setattr(vector_db, "CHROMA_AVAILABLE", True)
    monkeypatch.setattr(vector_db, "_SEMANTIC_ENABLED", True)

    # Toy embedder: direction is set by which keyword the text contains, so
    # "similar" texts really are near each other in the space.
    def fake_embed(text):
        lowered = text.lower()
        if "checkout" in lowered:
            base = [1.0, 0.0, 0.0]
        elif "database" in lowered:
            base = [0.0, 1.0, 0.0]
        else:
            base = [0.0, 0.0, 1.0]
        # a small nudge so near-duplicates are close but not identical
        nudge = (len(text) % 7) / 100.0
        return vector_db._normalise_vector([base[0] + nudge, base[1], base[2]])

    monkeypatch.setattr(vector_db, "_embed", fake_embed)
    yield collection
    vector_db.reset_cache()


# ------------------------------------------------------------------ exact layer

def test_first_query_reaches_the_collection(wired):
    hits = vector_db.query_fw("Built the checkout system", n_results=2)
    assert len(hits) == 2
    assert isinstance(hits[0], FwHit)
    assert wired.queries == 1


def test_identical_text_hits_the_exact_cache(wired):
    vector_db.query_fw("Built the checkout system", n_results=2)
    vector_db.query_fw("Built the checkout system", n_results=2)
    assert wired.queries == 1
    assert vector_db.get_cache_stats()["hits"] == 1


def test_whitespace_and_case_are_normalised(wired):
    vector_db.query_fw("Built the checkout system", n_results=2)
    vector_db.query_fw("  BUILT   the Checkout   System ", n_results=2)
    assert wired.queries == 1


def test_different_n_results_is_a_different_entry(wired):
    vector_db.query_fw("Built the checkout system", n_results=2)
    vector_db.query_fw("Built the checkout system", n_results=3)
    assert wired.queries == 2


# --------------------------------------------------------------- semantic layer

def test_near_duplicate_hits_the_semantic_cache(wired):
    vector_db.query_fw("Built the checkout system", n_results=2)
    vector_db.query_fw("Built the checkout system service", n_results=2)
    assert wired.queries == 1
    assert vector_db.get_cache_stats()["semantic_hits"] == 1


def test_unrelated_text_does_not_hit_the_semantic_cache(wired):
    vector_db.query_fw("Built the checkout system", n_results=2)
    vector_db.query_fw("Migrated the database cluster", n_results=2)
    assert wired.queries == 2
    assert vector_db.get_cache_stats()["semantic_hits"] == 0


def test_semantic_layer_respects_n_results(wired):
    vector_db.query_fw("Built the checkout system", n_results=2)
    vector_db.query_fw("Built the checkout system service", n_results=3)
    # Same meaning, different requested depth: must not serve the 2-result entry.
    assert wired.queries == 2


def test_semantic_cache_can_be_disabled(monkeypatch, wired):
    monkeypatch.setattr(vector_db, "_embed", lambda text: None)
    vector_db.query_fw("Built the checkout system", n_results=2)
    vector_db.query_fw("Built the checkout system service", n_results=2)
    assert wired.queries == 2


def test_expired_entries_are_not_served(monkeypatch, wired):
    vector_db.query_fw("Built the checkout system", n_results=2)
    real_monotonic = time.monotonic
    monkeypatch.setattr(
        vector_db.time, "monotonic",
        lambda: real_monotonic() + vector_db._CACHE_TTL_SECONDS + 1,
    )
    vector_db.query_fw("Built the checkout system", n_results=2)
    assert wired.queries == 2


# -------------------------------------------------------------------- eviction

def test_a_semantic_hit_stores_no_new_entry(wired):
    # The answer came from an existing entry, so there is nothing new to record.
    vector_db.query_fw("Built the checkout system", n_results=2)
    before = len(vector_db._fw_cache)
    vector_db.query_fw("Built the checkout system service", n_results=2)
    assert len(vector_db._fw_cache) == before


# -------------------------------------------------------------------- eviction
# Eviction is a property of the exact-key layer, so semantic lookup is switched
# off here — otherwise near-duplicate fixtures are served from cache and never
# populate it.

def test_eviction_keeps_the_cache_bounded(monkeypatch, wired):
    monkeypatch.setattr(vector_db, "_embed", lambda text: None)
    for i in range(vector_db._CACHE_MAX_ENTRIES + 20):
        vector_db.query_fw(f"unique bullet number {i} about widgets", n_results=1)
    assert len(vector_db._fw_cache) <= vector_db._CACHE_MAX_ENTRIES


def test_eviction_drops_the_oldest_not_everything(monkeypatch, wired):
    monkeypatch.setattr(vector_db, "_embed", lambda text: None)
    for i in range(vector_db._CACHE_MAX_ENTRIES + 5):
        vector_db.query_fw(f"unique bullet number {i} about widgets", n_results=1)
    # The old implementation cleared the whole cache on overflow, throwing away a
    # warm cache exactly when it had become useful.
    assert len(vector_db._fw_cache) > vector_db._CACHE_MAX_ENTRIES // 2


def test_eviction_retains_the_most_recent_entry(monkeypatch, wired):
    monkeypatch.setattr(vector_db, "_embed", lambda text: None)
    for i in range(vector_db._CACHE_MAX_ENTRIES + 5):
        vector_db.query_fw(f"unique bullet number {i} about widgets", n_results=1)
    queries_before = wired.queries
    vector_db.query_fw(
        f"unique bullet number {vector_db._CACHE_MAX_ENTRIES + 4} about widgets", n_results=1
    )
    assert wired.queries == queries_before  # newest survived eviction


# ----------------------------------------------------------------- empty index

def test_empty_collection_returns_no_hits(monkeypatch, wired):
    monkeypatch.setattr(wired, "_size", 0)
    assert vector_db.query_fw("anything at all", n_results=2) == []


# --------------------------------------------------------------- vector helpers

def test_normalise_vector_produces_unit_length():
    vector = vector_db._normalise_vector([3.0, 4.0])
    assert vector == pytest.approx([0.6, 0.8])


def test_normalise_vector_rejects_a_zero_vector():
    assert vector_db._normalise_vector([0.0, 0.0]) is None


def test_dot_of_identical_unit_vectors_is_one():
    vector = vector_db._normalise_vector([1.0, 2.0, 3.0])
    assert vector_db._dot(vector, vector) == pytest.approx(1.0)


def test_dot_of_mismatched_lengths_is_zero():
    assert vector_db._dot([1.0, 0.0], [1.0, 0.0, 0.0]) == 0.0
