import json
import re
from typing import Any

_THINK_BLOCK_RE = re.compile(r'<think(?:ing)?\b[^>]*>.*?</think(?:ing)?>', re.IGNORECASE | re.DOTALL)


def parse_json(raw: str) -> Any:
    """extract json from llm output, stripping reasoning traces, markdown fences and filler."""
    # reasoning models still emit a <think>...</think> block sometimes even when told not to,
    # strip it so the parse below doesn't mistake it for the answer
    cleaned = _THINK_BLOCK_RE.sub('', raw).strip()

    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        starts = [idx for idx, char in enumerate(cleaned) if char in "{["]
        for idx in starts:
            try:
                value, _ = decoder.raw_decode(cleaned[idx:])
                if isinstance(value, (dict, list)):
                    return value
            except json.JSONDecodeError:
                continue
        raise
