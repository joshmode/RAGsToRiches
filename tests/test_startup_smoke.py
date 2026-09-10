"""Guard the entry points. A repository that will not start is worse than a rough one.

These tests are deliberately shallow. They exist because `job_scraper.py` reached the
default branch carrying unresolved merge-conflict markers -- a SyntaxError in a module
`engine_api` imports at module scope, so a fresh clone could not start the engine at
all, while every unit test that never imported it went on passing. The same commit
also lost a `function` declaration in `App.jsx` and renamed an export the route files
still imported by its old name.

Nothing here checks behaviour. They check that the things which must load, load.
"""

from __future__ import annotations

import ast
import os

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Directories that are not ours to police.
_SKIP_DIRS = {".git", "node_modules", "__pycache__", "venv", ".venv", "chroma_db", "dist", "build"}

# A conflict marker is only ever a mistake in committed source. Anchored to the line
# start so prose about merge conflicts in a docstring cannot trip it.
_CONFLICT_PREFIXES = ("<<<<<<<", "=======", ">>>>>>>")


def _source_files(*extensions: str) -> list[str]:
    found: list[str] = []
    for directory, subdirectories, filenames in os.walk(REPO_ROOT):
        subdirectories[:] = [d for d in subdirectories if d not in _SKIP_DIRS]
        for filename in filenames:
            if filename.endswith(extensions):
                found.append(os.path.join(directory, filename))
    return sorted(found)


def _conflict_lines(path: str) -> list[tuple[int, str]]:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return [
            (number, line.rstrip("\n"))
            for number, line in enumerate(handle, start=1)
            if line.startswith(_CONFLICT_PREFIXES)
        ]


@pytest.mark.parametrize("path", _source_files(".py"), ids=os.path.basename)
def test_every_python_module_parses(path: str) -> None:
    """Catches the failure that actually happened, without importing anything."""
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    try:
        ast.parse(source, filename=path)
    except SyntaxError as error:  # pragma: no cover - only on a broken tree
        pytest.fail(f"{os.path.relpath(path, REPO_ROOT)}:{error.lineno}: {error.msg}")


def test_no_conflict_markers_in_tracked_source() -> None:
    offenders = {
        os.path.relpath(path, REPO_ROOT): _conflict_lines(path)
        for path in _source_files(".py", ".js", ".jsx", ".css", ".json", ".yml", ".yaml")
        if _conflict_lines(path)
    }
    assert not offenders, f"unresolved merge conflict markers: {offenders}"


def test_route_imports_match_engine_client_exports() -> None:
    """The Express routes and their client must agree on names.

    `fetchEngineWithRetry` was renamed to `fetchEngine` in the routes but not in the
    module that defines it, which is a clean import-time crash rather than a test
    failure -- so nothing in the Python suite could have noticed.
    """
    client_path = os.path.join(REPO_ROOT, "server", "engineClient.js")
    with open(client_path, encoding="utf-8") as handle:
        client_source = handle.read()

    exported = {
        line.split("function", 1)[1].split("(", 1)[0].strip()
        for line in client_source.splitlines()
        if line.startswith("export ") and "function" in line
    }
    assert exported, "engineClient.js exports no functions"

    routes_dir = os.path.join(REPO_ROOT, "server", "routes")
    missing: dict[str, list[str]] = {}
    for filename in sorted(os.listdir(routes_dir)):
        if not filename.endswith(".js"):
            continue
        with open(os.path.join(routes_dir, filename), encoding="utf-8") as handle:
            for line in handle:
                if "engineClient.js" not in line or not line.startswith("import"):
                    continue
                names = line.split("{", 1)[1].split("}", 1)[0]
                wanted = {name.strip() for name in names.split(",") if name.strip()}
                if absent := sorted(wanted - exported):
                    missing[filename] = absent
    assert not missing, f"routes import names engineClient.js does not export: {missing}"
