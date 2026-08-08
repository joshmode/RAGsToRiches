import os
import hashlib
import math
import time
from dataclasses import dataclass
from typing import Any

try:
    import chromadb
    from chromadb.utils import embedding_functions
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False


@dataclass
class FwHit:
    document:  str
    framework: str
    category:  str
    score:     float


import threading
_col = None
_lock = threading.Lock()
_CHROMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")

FRAMEWORKS = [
    {"id": "google_xyz", "metadata": {"framework": "Google XYZ", "category": "structure"}, "document": "Google XYZ Formula: Accomplished [X] as measured by [Y], by doing [Z]. X = the achievement, Y = how you prove it with a number, Z = the method or tool used. Example strong: 'Improved model inference speed by 2x, as measured by p95 latency dropping from 800ms to 400ms, by switching to a batched prediction pipeline.' Example weak (before): 'Worked on improving the model speed.' Apply this to every bullet in the experience section. If Y is missing, prompt the user to add a metric."},
    {"id": "star_method", "metadata": {"framework": "STAR", "category": "structure"}, "document": "STAR Method: Situation, Task, Action, Result. Best for project and internship bullets where context matters. Example: 'Facing 30% drop in checkout conversions (S), I was tasked with diagnosing the UX failure (T). I ran A/B tests across 3 UI variants (A), recovering conversions to baseline within 2 weeks (R).' Keep it concise — STAR bullets should still be one or two lines max on a resume. Lead with the result when the impact is strong enough to be a hook."},
    {"id": "rule_of_3", "metadata": {"framework": "Rule of 3", "category": "structure"}, "document": "Rule of 3: Every bullet needs three elements — action verb, measurable metric, clear outcome. Example strong: 'Reduced API response time by 40% by refactoring the caching layer, improving user retention by 15%.' Example weak: 'Helped with backend work.' Ask three questions about every bullet: What did you do? By how much? So what? If any answer is missing, the bullet is incomplete."},
    {"id": "action_verbs", "metadata": {"framework": "ATS", "category": "language"}, "document": "Strong ATS action verbs — always start bullets with one of these (past tense). Engineering: Architected, Deployed, Optimised, Refactored, Automated, Integrated, Migrated, Debugged, Implemented. Leadership: Spearheaded, Directed, Mentored, Coordinated, Oversaw, Championed. Impact: Reduced, Increased, Improved, Accelerated, Delivered, Generated, Achieved, Streamlined. Research: Investigated, Analysed, Modelled, Evaluated, Benchmarked, Prototyped. Never start with: 'I', 'We', 'Responsible for', 'Helped', 'Assisted', 'Worked on'. These are passive and get filtered by ATS scanners."},
    {"id": "weak_phrases", "metadata": {"framework": "ATS", "category": "anti-patterns"}, "document": "Weak phrases that kill resume bullets and how to fix them. 'Responsible for X' → rewrite as a direct action: 'Built X that achieved Y.' 'Helped with X' → be specific: 'Designed the X module, contributing Y% of total codebase.' 'Worked on X' → name what you shipped: 'Delivered X feature, adopted by N users.' 'Familiar with X' → only list skills you can speak to in an interview. 'Good communication skills' → demonstrate it: 'Presented findings to 30+ stakeholders, securing budget approval.' 'Various tasks' → list the top 2–3 concrete things you actually did."},
    {"id": "quantification_guide", "metadata": {"framework": "Rule of 3", "category": "metrics"}, "document": "How to add numbers when you don't think you have any. Team size: 'Collaborated with a 6-person cross-functional team.' Scale: 'System served 10,000 daily active users.' Time saved: 'Automated the reporting pipeline, saving ~3 hours of manual work per week.' Scope: 'Led migration of 5 legacy services to a microservices architecture.' Ranking: 'Ranked top 10% among 200 interns in end-of-term evaluation.' Frequency: 'Conducted weekly code reviews across 4 junior developers.' If you genuinely have no numbers, use scope, frequency, or relative improvement — anything is better than a bullet with no anchor."},
    {"id": "projects_section_guide", "metadata": {"framework": "Google XYZ", "category": "projects"}, "document": "How to write strong project bullets. Lead with what you built, not what it is: 'Built an X that does Y' not 'X is a project that...' Always mention: tech stack used, scale or users if applicable, and what problem it solved. Example: 'Developed a RAG-based resume optimiser using LangChain, ChromaDB, and FastAPI, reducing user time-to-feedback from hours to under 60 seconds.' Include GitHub link if the repo is public. For academic projects: mention dataset size, model accuracy, or benchmark improvement."},
    {"id": "education_section_guide", "metadata": {"framework": "structure", "category": "education"}, "document": "Education section best practices. Format: Degree, Major — University Name (Graduation Year) | GPA if above 3.5/4.0 or equivalent. List relevant coursework only if you have fewer than 2 years of experience. Achievements like Dean's List, scholarships, or top-cohort rankings belong here. For NUS/NTU/SMU students: CAP score is worth including if above 4.0. Don't list high school if you have a university degree."},
]


def _get_col() -> Any:
    global _col
    if not CHROMA_AVAILABLE:
        raise ImportError("ChromaDB is required. Run: pip install chromadb sentence-transformers")

    with _lock:
        if _col is not None:
            return _col

        _col = chromadb.PersistentClient(path=_CHROMA_PATH).get_or_create_collection(
            name="resume_frameworks",
            embedding_function=embedding_functions.SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2"),
            metadata={"hnsw:space": "cosine"},
        )

        if _col.count() == 0:
            _col.upsert(
                ids=[f["id"] for f in FRAMEWORKS],
                documents=[f["document"] for f in FRAMEWORKS],
                metadatas=[f["metadata"] for f in FRAMEWORKS],
            )
    return _col


@dataclass
class _CacheEntry:
    stored_at: float
    hits: list[FwHit]
    embedding: list[float] | None  # L2-normalised, so similarity is a dot product


_fw_cache: dict[str, _CacheEntry] = {}
_fw_cache_lock = threading.Lock()
_CACHE_TTL_SECONDS = 3600
_CACHE_MAX_ENTRIES = 256

# Two bullets this close ask for the same writing framework. Tuned conservatively:
# a miss only costs the retrieval we were going to do anyway, whereas a false hit
# would hand a bullet guidance chosen for a different one.
_SEMANTIC_THRESHOLD = float(os.environ.get("FW_SEMANTIC_THRESHOLD", "0.93"))
_SEMANTIC_ENABLED = os.environ.get("FW_SEMANTIC_CACHE", "true").lower() != "false"

_cache_hits = 0
_cache_misses = 0
_semantic_hits = 0


def _normalise_vector(vector: list[float]) -> list[float] | None:
    magnitude = math.sqrt(sum(value * value for value in vector))
    if magnitude == 0:
        return None
    return [value / magnitude for value in vector]


def _dot(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        return 0.0
    return sum(a * b for a, b in zip(left, right))


_embedder = None
_embedder_lock = threading.Lock()


def _get_embedder() -> Any:
    """The shared sentence-transformer, built once.

    Constructing one per call would reload the model on every bullet, which costs
    far more than the retrieval the cache exists to avoid.
    """
    global _embedder
    if _embedder is not None:
        return _embedder
    with _embedder_lock:
        if _embedder is None:
            _embedder = embedding_functions.SentenceTransformerEmbeddingFunction(
                model_name="all-MiniLM-L6-v2"
            )
    return _embedder


def _embed(text: str) -> list[float] | None:
    """Embed one query with the same model the collection is indexed under.

    Returns ``None`` when embeddings are unavailable, in which case the caller
    silently falls back to exact-key caching and behaves exactly as before.
    """
    if not _SEMANTIC_ENABLED or not CHROMA_AVAILABLE:
        return None
    try:
        vectors = _get_embedder()([text])
        if vectors is None or len(vectors) == 0:
            return None
        return _normalise_vector([float(value) for value in vectors[0]])
    except Exception:
        return None


def _semantic_lookup(
    embedding: list[float],
    n_results: int,
    now: float,
) -> list[FwHit] | None:
    """Best live cache entry within the similarity threshold, if any.

    Caller must hold ``_fw_cache_lock``. Entries are already normalised, so the
    scan is a dot product per entry — trivial at 256 entries of 384 dimensions.
    """
    best_hits: list[FwHit] | None = None
    best_score = _SEMANTIC_THRESHOLD
    for key, entry in _fw_cache.items():
        if entry.embedding is None or now - entry.stored_at >= _CACHE_TTL_SECONDS:
            continue
        if not key.endswith(f"::{n_results}::v2"):
            continue
        score = _dot(embedding, entry.embedding)
        if score >= best_score:
            best_score = score
            best_hits = entry.hits
    return best_hits


def query_fw(text: str, n_results: int = 3) -> list[FwHit]:
    """Retrieve the most relevant writing framework docs for RAG context.

    Two cache layers. An exact normalised-text key catches repeated bullets, then
    a semantic layer catches near-duplicates ("Built the API" against "Built the
    API gateway"), which the hash layer misses entirely.

    Note what is deliberately *not* cached semantically: the generated rewrite.
    Framework guidance is genuinely shared between similar bullets, but a rewrite
    is specific to its bullet — serving a 0.95-similar bullet's rewrite would put
    another bullet's wording on someone's CV. The cache only covers retrieval.
    """
    global _cache_hits, _cache_misses, _semantic_hits

    normalized = " ".join(text.split()).lower()
    cache_key = f"{hashlib.sha256(normalized.encode('utf-8')).hexdigest()}::{n_results}::v2"
    now = time.monotonic()

    with _fw_cache_lock:
        cached = _fw_cache.get(cache_key)
        if cached and now - cached.stored_at < _CACHE_TTL_SECONDS:
            _cache_hits += 1
            return cached.hits

    embedding = _embed(text)
    if embedding is not None:
        with _fw_cache_lock:
            near = _semantic_lookup(embedding, n_results, time.monotonic())
            if near is not None:
                _cache_hits += 1
                _semantic_hits += 1
                return near

    with _fw_cache_lock:
        _cache_misses += 1

    col = _get_col()
    n = min(n_results, col.count())
    if n == 0:
        return []

    res = col.query(query_texts=[text], n_results=n, include=["documents", "metadatas", "distances"])

    hits = [
        FwHit(
            document=doc,
            framework=meta.get("framework", ""),
            category=meta.get("category", ""),
            score=round(1 - dist, 3)
        )
        for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0])
    ]

    with _fw_cache_lock:
        if len(_fw_cache) >= _CACHE_MAX_ENTRIES:
            _evict_locked()
        _fw_cache[cache_key] = _CacheEntry(time.monotonic(), hits, embedding)

    return hits


def _evict_locked() -> None:
    """Drop expired entries, then the oldest, rather than clearing everything.

    A full clear threw away a warm semantic cache on every 257th distinct bullet,
    which is exactly when it had become useful.
    """
    now = time.monotonic()
    for key in [k for k, e in _fw_cache.items() if now - e.stored_at >= _CACHE_TTL_SECONDS]:
        _fw_cache.pop(key, None)
    while len(_fw_cache) >= _CACHE_MAX_ENTRIES:
        oldest = min(_fw_cache, key=lambda k: _fw_cache[k].stored_at)
        _fw_cache.pop(oldest, None)


def get_cache_stats() -> dict[str, int]:
    with _fw_cache_lock:
        return {
            "hits": _cache_hits,
            "misses": _cache_misses,
            "semantic_hits": _semantic_hits,
            "entries": len(_fw_cache),
        }


def reset_cache() -> None:
    """Clear cache and counters. Used by tests."""
    global _cache_hits, _cache_misses, _semantic_hits
    with _fw_cache_lock:
        _fw_cache.clear()
        _cache_hits = _cache_misses = _semantic_hits = 0
