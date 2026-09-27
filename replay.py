"""An offline stand-in for a model, for demos and end-to-end tests.

The replay provider answers from responses recorded for the bundled sample
resume and job description (demo/replay.json), so the whole app runs without an
API key: the rewrites, both critics, the job description read, the CV and the
cover letter. The recordings include the failures the guards exist for, a verb
escalation, an invented figure and a job keyword the bullet doesn't support, so
the demo shows them being caught.

Anything without a recording gets a plain, cautious answer: the bullet's own
wording with a marker where a figure would help. It never supplies a number,
because it can't know one.
"""

from __future__ import annotations

import functools
import json
import os
import re

from claims import verb_escalation
from job_fit import keyword_in
from scoring import bullet_signals

_FIXTURES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo", "replay.json")

# enough of a tech vocabulary to read a job description without a model
_VOCABULARY = [
    "Python", "Go", "Java", "JavaScript", "TypeScript", "C++", "C#", ".NET", "Rust", "Ruby", "Kotlin",
    "Swift", "Scala", "SQL", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "RabbitMQ", "Spark",
    "Airflow", "dbt", "Snowflake", "BigQuery", "AWS", "GCP", "Azure", "Docker", "Kubernetes", "Terraform",
    "Ansible", "CI/CD", "GitHub Actions", "Jenkins", "Linux", "React", "Next.js", "Vue", "Angular",
    "Node.js", "Django", "Flask", "FastAPI", "Spring", "GraphQL", "REST", "gRPC", "microservices",
    "machine learning", "PyTorch", "TensorFlow", "pandas", "Tableau", "Figma", "agile", "Scrum",
    "observability", "Prometheus", "Grafana", "security", "testing",
]

_BATCH_BULLET_RE = re.compile(r'^\[(\d+)\] \(guides: [^)]*\) (.+)$', re.MULTILINE)
_SINGLE_BULLET_RE = re.compile(r'BULLET TO REWRITE:\n(.+?)\n')
_AUDIT_PAIR_RE = re.compile(r'\[(\d+)\]\nORIGINAL: (.*)\nREWRITE: (.*)')
_COMPANY_RE = re.compile(r"\b(?:at|join|About)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})")


@functools.lru_cache(maxsize=1)
def _fixtures() -> dict:
    with open(_FIXTURES_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def _key(text: str) -> str:
    return " ".join((text or "").lower().split())


def answer(user_prompt: str, system_prompt: str = "") -> str:
    """The recorded (or cautious) answer to one of the pipeline's prompts."""
    if "Read this job description" in user_prompt:
        return json.dumps(_jd_profile(user_prompt.split("Job description:\n", 1)[-1]))
    if "Compare these two text strings" in user_prompt:
        # only asked when the check already found a figure the original lacks
        return "FAIL: the original bullet gives no figure for this."
    if "rewrite pairs" in user_prompt and "ORIGINAL:" in user_prompt:
        return json.dumps(_audit(user_prompt))
    if "BULLETS TO REWRITE" in user_prompt:
        return json.dumps([
            {"index": int(index), **_rewrite(bullet)}
            for index, bullet in _BATCH_BULLET_RE.findall(user_prompt)
        ])
    match = _SINGLE_BULLET_RE.search(user_prompt)
    if match:
        return json.dumps(_rewrite(match.group(1), repaired="CRITIC FEEDBACK" in user_prompt))
    if "CV formatter" in system_prompt:
        return _cv(user_prompt)
    if "cover letter writer" in system_prompt:
        return _cover_letter(user_prompt)
    return ""


# ------------------------------------------------------------------- rewrites

def _rewrite(bullet: str, repaired: bool = False) -> dict:
    recorded = _fixtures()["rewrites"].get(_key(bullet))
    if recorded:
        chosen = recorded.get("repaired", recorded) if repaired else recorded
        return {k: v for k, v in chosen.items() if k != "repaired"}

    signals = bullet_signals(bullet)
    text = bullet.strip().rstrip(".")
    return {
        "rewritten": text if signals["quantified"] else f"{text} [add a measurable result]",
        "reasoning": "Offline demo: no recorded answer for this bullet, so it only marks where a figure would help.",
        "framework_used": "Google XYZ",
        "severity": "red" if signals["score"] < 40 else "yellow" if signals["score"] < 75 else "green",
    }


def _audit(prompt: str) -> list[dict]:
    audits = _fixtures().get("audits", {})
    verdicts = []
    for index, original, rewrite in _AUDIT_PAIR_RE.findall(prompt):
        recorded = audits.get(_key(original))
        escalation = verb_escalation(original, rewrite)
        if recorded:
            verdicts.append({"index": int(index), **recorded})
        elif escalation:
            verdicts.append({"index": int(index), "verdict": "overstated", "kind": "role", "reason": escalation["detail"]})
        else:
            verdicts.append({"index": int(index), "verdict": "ok", "kind": "none", "reason": ""})
    return verdicts


# --------------------------------------------------------- job description

def _jd_profile(job_desc: str) -> dict:
    for recorded in _fixtures().get("jd_profiles", []):
        if recorded["match"] in job_desc:
            return recorded["profile"]

    lower = job_desc.lower()
    keywords = [term for term in _VOCABULARY if keyword_in(term, lower)]
    company = _COMPANY_RE.search(job_desc)
    return {
        "keywords": keywords,
        "company": company.group(1) if company else "",
        "tips": ["Offline demo: tips need a real model. The keyword match above is exact."],
    }


# ------------------------------------------------------------------ documents

def _resume_blocks(prompt: str, marker: str) -> tuple[dict, list[tuple[str, list[str]]]]:
    """Contact details and (section, lines) pairs from the resume inside a prompt."""
    body = prompt.split(marker, 1)[-1]
    contact: dict[str, str] = {}
    sections: list[tuple[str, list[str]]] = []
    current = None
    for raw in body.splitlines():
        line = raw.strip()
        if line.startswith("Generate the complete"):
            break
        heading = re.match(r'^=== (.+) ===$', line)
        if heading:
            current = heading.group(1)
            if current != "CONTACT":
                sections.append((current, []))
        elif not line or current is None:
            continue
        elif current == "CONTACT":
            if ":" in line:
                key, value = line.split(":", 1)
                contact[key.strip()] = value.strip()
        else:
            sections[-1][1].append(line)
    return contact, sections


def _contact_line(contact: dict) -> str:
    return " | ".join(v for k, v in contact.items() if k != "name")


def _cv(prompt: str) -> str:
    contact, sections = _resume_blocks(prompt, "CANDIDATE RESUME (final wording")
    out = [f"# {contact.get('name', 'Candidate')}", _contact_line(contact), ""]
    for section, lines in sections:
        out += [f"## {section}", "---"]
        for line in lines:
            # a role or project heading, not a bullet
            if not line.startswith("-") and ("|" in line or re.search(r'\b(?:19|20)\d{2}\b', line)):
                out.append(f"### {line}")
            else:
                out.append(f"- {line.lstrip('-•* ').strip()}")
        out.append("")
    return "\n".join(out).strip()


def _cover_letter(prompt: str) -> str:
    contact, sections = _resume_blocks(prompt, "CANDIDATE RESUME:")
    date = re.search(r'DATE TO USE: (.+)', prompt)
    jd = prompt.split("JOB DESCRIPTION:\n", 1)[-1].split("CANDIDATE RESUME:", 1)[0]
    company = _jd_profile(jd)["company"] if "None provided" not in jd else ""
    bullets = [line.lstrip("-•* ").strip() for _section, lines in sections for line in lines if line.startswith("-")]
    name = contact.get("name", "Candidate")
    return "\n".join([
        f"# {name}",
        _contact_line(contact),
        "",
        date.group(1).strip() if date else "",
        "",
        f"Dear Hiring Team{' at ' + company if company else ''},",
        "",
        "I'm writing to apply for the role you've advertised. This letter was produced by the offline "
        "demo, which replays recorded answers instead of calling a model, so it only restates what the "
        "resume already says.",
        "",
        f"Most relevant from my resume: {bullets[0] if bullets else 'my recent work'}. "
        f"I have also {bullets[1][0].lower() + bullets[1][1:] if len(bullets) > 1 else 'kept building on it'}.",
        "",
        "I'd welcome the chance to talk about how that experience fits the team. Thank you for your time.",
        "",
        "Sincerely,",
        name,
    ])
