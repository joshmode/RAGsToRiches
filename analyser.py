from typing import Any
import hashlib
import json
import re
from dotenv import load_dotenv

from vector_db import query_frameworks
from parser import ParsedResume
from router import generate_response

load_dotenv()


def _keyword_in_resume(kw: str, resume_lower: str) -> bool:
    pattern = r'\b' + re.escape(kw.lower()) + r'\b'
    return bool(re.search(pattern, resume_lower))


def get_keyword_frequencies(jd_keywords: list[str], resume_text: str) -> dict[str, int]:
    resume_lower = resume_text.lower()
    freqs = {}
    for kw in jd_keywords:
        pattern = r'\b' + re.escape(kw.lower()) + r'\b'
        matches = re.findall(pattern, resume_lower)
        if matches:
            freqs[kw] = len(matches)
    return freqs


def _safe_deserialize_json(raw_text: str) -> Any:
    """Aggressively extracts JSON from raw LLM output, ignoring markdown and conversational filler."""
    cleaned = raw_text.strip()

    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    # Use regex to find the first and the last 
    match = re.search(r'(\{.*\})', cleaned, re.DOTALL)
    if match:
        cleaned = match.group(1)

    return json.loads(cleaned)


def extract_jd_keywords(job_description: str, provider: str, local_endpoint: str, model: str = "") -> list[str]:
    """Ask the LLM to pull every technical skill, tool, methodology, and credential out of the job description."""
    if not job_description.strip():
        return []

    prompt = (
        "Extract every technical skill, tool, framework, methodology, certification, "
        "and domain-specific keyword from this job description. "
        "Return ONLY a JSON array of short strings — no explanation, no markdown fences. "
        'Example output: ["Python", "Docker", "CI/CD", "REST API", "agile"]\n\n'
        f"Job description:\n{job_description}"
    )

    try:
        raw = generate_response(
            user_prompt=prompt, 
            provider=provider, 
            local_endpoint=local_endpoint,
            model=model,
            max_tokens=1024
        )
        return _safe_deserialize_json(raw)
    except Exception as e:
        print(f"Keyword extraction failed: {e}")
        return []


def rewrite_bullet(
    bullet: str, 
    frameworks: list[Any], 
    missing_keywords: list[str], 
    provider: str, 
    local_endpoint: str,
    use_critic: bool = False,
    model: str = ""
) -> dict:
    framework_context = "\n\n".join(f.document for f in frameworks)
    # We only pass the first 12 keywords to save tokens
    keywords_hint = ", ".join(missing_keywords[:12]) if missing_keywords else "none"

    system_prompt = (
        "You are an expert resume coach. You rewrite weak resume bullets into strong, "
        "ATS-optimised, results-driven statements grounded in industry frameworks. "
        "Never invent metrics the user didn't provide — if a number is missing, "
        "use a placeholder like [X%] and note it in reasoning. "
        "Always respond with valid JSON only, no markdown."
    )

    user_prompt = (
        f"FRAMEWORK GUIDANCE (apply the most relevant one):\n{framework_context}\n\n"
        f"ATS KEYWORDS TO WEAVE IN NATURALLY (only if genuinely relevant):\n{keywords_hint}\n\n"
        f"BULLET TO REWRITE:\n{bullet}\n\n"
        "Respond with this exact JSON structure:\n"
        "{\n"
        '  "rewritten": "the improved bullet point",\n'
        '  "reasoning": "one sentence: what was weak, what framework was applied, what changed",\n'
        '  "framework_used": "Google XYZ | STAR | Rule of 3 | Action Verb | other",\n'
        '  "severity": "red | yellow | green"\n'
        "}\n"
        "Severity guide: red = hallucinated or very weak passive language ('helped with'). yellow = missing a metric but structurally sound. green = strong, matches ATS perfectly."
    )

    last_error = None

    # retry loop to catch json hallucinations 
    for attempt in range(3):
        try:
            raw = generate_response(
                user_prompt=user_prompt,
                system_prompt=system_prompt,
                provider=provider,
                local_endpoint=local_endpoint,
                model=model,
                max_tokens=1024
            )
            result = _safe_deserialize_json(raw)

            severity = result.get("severity", "yellow").lower()
            if severity not in ("red", "yellow", "green"):
                severity = "yellow"
            result["severity"] = severity

            # Agentic self-correction loop
            if use_critic:
                critic_prompt = (
                    "You are a strict QA Critic for resume rewrites. "
                    f"Original Bullet: {bullet}\n"
                    f"Rewritten Bullet: {result.get('rewritten', bullet)}\n"
                    "Did the rewrite invent any specific metrics, numbers, or percentages that were NOT in the original bullet? "
                    "(Placeholders like [X%] are allowed). "
                    "Return ONLY 'PASS' if it is safe, or 'FAIL: <reason>' if it hallucinated."
                )

                critic_raw = generate_response(
                    user_prompt=critic_prompt,
                    provider=provider,
                    local_endpoint=local_endpoint,
                    model=model,
                    max_tokens=100
                )

                if critic_raw.strip().startswith("FAIL"):
                    retry_prompt = user_prompt + f"\n\nCRITIC FEEDBACK: {critic_raw.strip()}\nPlease fix the hallucination and ensure no new metrics are invented."
                    retry_raw = generate_response(
                        user_prompt=retry_prompt,
                        system_prompt=system_prompt,
                        provider=provider,
                        local_endpoint=local_endpoint,
                        model=model,
                        max_tokens=1024
                    )

                    try:
                        result = _safe_deserialize_json(retry_raw)
                    except Exception:
                        pass

                    severity = result.get("severity", "yellow").lower()
                    if severity not in ("red", "yellow", "green"):
                        severity = "yellow"
                    result["severity"] = severity

            result["original"] = bullet
            return result

        except json.JSONDecodeError as e:
            last_error = e
            import time
            time.sleep(1)
            continue

        except Exception as e:
            last_error = e
            break

    print(f"Bullet rewrite bypassed: {last_error}")
    return {
        "original":       bullet,
        "rewritten":      bullet,
        "reasoning":      "Rewrite skipped due to model formatting failure.",
        "framework_used": "error",
        "severity":       "red"
    }


_BULLET_PREFIX_RE = re.compile(r'^\s*(?:[-*•‣▪▫◦●]|\d+[.)]|[a-zA-Z][.)])\s+')
_DATE_RE = re.compile(r'\b(?:19|20)\d{2}\b|\b(?:present|current)\b', re.IGNORECASE)
_DATE_RANGE_RE = re.compile(
    r'\b(?:19|20)\d{2}\s*(?:[-–—]|to)\s*(?:(?:19|20)\d{2}|present|current)\b',
    re.IGNORECASE,
)
# Matches lines like "Secretary to Director, TSMC 2022 - 2025" or "Software Engineer | Google | 2021 – Present"
_JOB_TITLE_RE = re.compile(
    r'^[A-Z][A-Za-z\s,/&]+'
    r'(?:[,|–—\-]\s*[A-Z][A-Za-z\s,&.]+)*'
    r'\s*[,|–—\-]?\s*'
    r'(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+)?'
    r'(?:19|20)\d{2}',
    re.IGNORECASE,
)
_ACTION_VERBS = {
    "achieved", "administered", "analysed", "analyzed", "automated", "built", "collaborated",
    "conducted", "created", "delivered", "designed", "developed", "drove", "enabled",
    "engineered", "executed", "improved", "increased", "launched", "led", "managed",
    "investigated", "optimised", "optimized", "owned", "partnered", "prepared", "reduced",
    "resolved", "shipped", "streamlined", "supported", "trained", "transformed",
    "implemented", "utilised", "utilized", "spearheaded", "directed", "orchestrated",
    "programmed", "architected", "mentored", "published", "researched", "formulated",
    "integrated", "migrated", "debugged", "facilitated", "generated", "coordinated",
    "evaluated", "benchmarked", "prototyped",
}


def _strip_bullet_prefix(line: str) -> tuple[str, bool]:
    stripped = re.sub(r'\s+', ' ', line).strip()
    match = _BULLET_PREFIX_RE.match(stripped)
    if not match:
        return stripped, False
    return stripped[match.end():].strip(), True


def _sentence_complete(text: str) -> bool:
    return bool(re.search(r'[.!?]\s*$', text.strip()))


def _first_word(text: str) -> str:
    match = re.match(r'^[^\w]*([A-Za-z]+)', text.strip())
    return match.group(1).lower() if match else ""


def _is_header_like(line: str, section: str = "") -> bool:
    cleaned, explicit_bullet = _strip_bullet_prefix(line)
    if explicit_bullet:
        return False

    words = cleaned.split()
    word_count = len(words)
    if word_count == 0:
        return True

    # Treat short label lines as headers
    if word_count <= 3 and cleaned.endswith(":"):
        return True

    # Relax short-line detection for all descriptive sections
    relaxed_sections = ("PROJECTS", "EDUCATION", "SKILLS", "CERTIFICATIONS", "AWARDS", "VOLUNTEER")
    if section not in relaxed_sections and word_count <= 4 and not _sentence_complete(cleaned):
        return True

    # Job title or role lines with date ranges must not be rewritten
    has_date_range = bool(_DATE_RANGE_RE.search(cleaned))
    has_date = bool(_DATE_RE.search(cleaned))

    if has_date_range and word_count <= 20 and not _sentence_complete(cleaned):
        return True
    if has_date and word_count <= 14 and not _sentence_complete(cleaned):
        return True

    if _JOB_TITLE_RE.match(cleaned) and not _sentence_complete(cleaned):
        return True

    #Skills lists are almost entirely nouns. Bypassing this stops them from being thrown out.
    if section == "SKILLS":
        return False

    titleish_words = sum(1 for word in words if word[:1].isupper() or word.isupper())
    titleish_ratio = titleish_words / max(word_count, 1)
    starts_with_action = _first_word(cleaned) in _ACTION_VERBS

    #Raised the ratio threshold from 0.55 to 0.75 so descriptive bullets aren't falsely flagged
    if titleish_ratio >= 0.75 and word_count <= 14 and not starts_with_action and not _sentence_complete(cleaned):
        return True

    return False


def _line_is_rewrite_candidate(line: str, explicit_bullet: bool = False, section: str = "") -> bool:
    cleaned, marker_found = _strip_bullet_prefix(line)
    explicit_bullet = explicit_bullet or marker_found
    words = cleaned.split()
    if _is_header_like(line, section=section):
        return False

    # projects and volunteer sections often have shorter descriptions so just allow it 
    relaxed_sections = ("PROJECTS", "VOLUNTEER", "SUMMARY", "SKILLS", "EDUCATION")
    min_chars = 20 if section in relaxed_sections else 35
    min_words = 3 if section in relaxed_sections else 6

    if len(cleaned) < min_chars or len(words) < min_words:
        return False

    if re.search(r'@|linkedin\.com|github\.com|https?://', cleaned, re.IGNORECASE):
        return False

    return explicit_bullet or len(words) >= (3 if section in relaxed_sections else 7)


def _looks_like_bullet(line: str) -> bool:
    return _line_is_rewrite_candidate(line)


def _make_rewrite_id(section_name: str, line_indices: list[int], text: str) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
    first_line = line_indices[0] if line_indices else 0
    return f"{section_name}:{first_line}:{digest}"


def _flush_rewrite_unit(
    units: list[dict[str, Any]],
    section_name: str,
    buffer: list[tuple[int, str]],
    eligible: bool,
) -> None:
    if not buffer:
        return
    line_indices = [idx for idx, _ in buffer]
    text = " ".join(_strip_bullet_prefix(line)[0] for _, line in buffer)
    text = re.sub(r'\s+', ' ', text).strip()
    units.append({
        "id": _make_rewrite_id(section_name, line_indices, text),
        "text": text,
        "line_indices": line_indices,
        "eligible": eligible and _line_is_rewrite_candidate(text, section=section_name),
    })


def _build_rewrite_units(section_name: str, lines: list[str]) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    buffer: list[tuple[int, str]] = []
    buffer_eligible = False

    for idx, line in enumerate(lines):
        cleaned, explicit_bullet = _strip_bullet_prefix(line)
        if not cleaned:
            continue

        header_like = _is_header_like(line, section=section_name)
        candidate = _line_is_rewrite_candidate(line, explicit_bullet=explicit_bullet, section=section_name)
        if header_like:
            _flush_rewrite_unit(units, section_name, buffer, buffer_eligible)
            _flush_rewrite_unit(units, section_name, [(idx, line)], False)
            buffer = []
            buffer_eligible = False
            continue

        # Only start a new unit on an explicit bullet market. Do NOT split mid-sentence just because an action verb appears
        buffer_text = " ".join(part for _, part in buffer) if buffer else ""
        buffer_complete = _sentence_complete(buffer_text)
        starts_new_unit = (
            explicit_bullet
            or not buffer
            or (buffer_complete and candidate)
        )

        if starts_new_unit:
            _flush_rewrite_unit(units, section_name, buffer, buffer_eligible)
            buffer = [(idx, line)]
            buffer_eligible = candidate and not header_like
        else:
            buffer.append((idx, line))
            buffer_eligible = buffer_eligible or candidate

    _flush_rewrite_unit(units, section_name, buffer, buffer_eligible)
    return units


def compute_score(resume: ParsedResume, jd_keywords: list[str], missing: list[str], rewrites: dict[str, list[dict]]) -> dict:
    score_breakdown = {
        "base": 30,
        "sections": 0,
        "keywords": 0,
        "bullet_quality": 0,
        "action_verbs": 0,
        "warnings": 0,
        "total": 0
    }

    # +8 per major section present (max 32)
    for section in ("EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"):
        if section in resume.sections:
            score_breakdown["sections"] += 8

    # Keyword coverage: up to +20
    if jd_keywords:
        found = len(jd_keywords) - len(missing)
        coverage = found / len(jd_keywords)
        score_breakdown["keywords"] += int(coverage * 20)

    # Bullet quality by severity: green=+2, yellow=+1, cap at 10
    quality_pts = 0
    actionable_count = 0
    action_verb_hits = 0
    for section_items in rewrites.values():
        for item in section_items:
            if item.get("framework_used") in ("none", "error"):
                continue
            if item.get("original") == item.get("rewritten"):
                continue
            actionable_count += 1
            sev = item.get("severity", "yellow")
            if sev == "green":
                quality_pts += 2
            elif sev == "yellow":
                quality_pts += 1
            # Check if rewritten bullet starts with a strong action verb
            first_word = item.get("rewritten", "").split()[0].lower().rstrip(".,;:") if item.get("rewritten", "").strip() else ""
            if first_word in _ACTION_VERBS:
                action_verb_hits += 1
    score_breakdown["bullet_quality"] = min(10, quality_pts)

    # Action verb usage: up to +8
    if actionable_count > 0:
        verb_ratio = action_verb_hits / actionable_count
        score_breakdown["action_verbs"] = min(8, int(verb_ratio * 8))

    # Warnings penalty: -3 per missing section warning
    score_breakdown["warnings"] = -(len([w for w in resume.warnings if "not detected" in w]) * 3)

    total = sum(v for k, v in score_breakdown.items() if k != "total")
    score_breakdown["total"] = max(0, min(100, total))
    return score_breakdown


def analyse_resume(
    resume: ParsedResume, 
    job_description: str, 
    provider: str = "gemini", 
    local_endpoint: str = "",
    use_critic: bool = False,
    model: str = ""
) -> dict:
    jd_keywords = extract_jd_keywords(job_description, provider, local_endpoint, model=model) if job_description.strip() else []

    resume_lower = resume.raw_text.lower()
    missing_keywords = [kw for kw in jd_keywords if not _keyword_in_resume(kw, resume_lower)]

    rewrites: dict[str, list[dict]] = {}

    # Main sections 
    primary_sections = ("EXPERIENCE", "PROJECTS", "VOLUNTEER", "SUMMARY")
    # Descriptive sections we exclude obvious non-descriptive sections
    descriptive_sections = ("SKILLS", "EDUCATION", "CERTIFICATIONS", "AWARDS", "PUBLICATIONS", "INTERESTS")

    for section_name in primary_sections:
        lines = resume.sections.get(section_name, [])
        if not lines:
            continue

        section_rewrites = []
        for unit in _build_rewrite_units(section_name, lines):
            if unit["eligible"]:
                frameworks = query_frameworks(unit["text"], n_results=2)
                rewrite    = rewrite_bullet(unit["text"], frameworks, missing_keywords, provider, local_endpoint, use_critic, model=model)
            else:
                rewrite = {
                    "original":       unit["text"],
                    "rewritten":      unit["text"],
                    "reasoning":      "Header or date line — no rewrite needed.",
                    "framework_used": "none",
                }
            rewrite["id"] = unit["id"]
            rewrite["section"] = section_name
            rewrite["line_indices"] = unit["line_indices"]
            rewrite["highlight_text"] = unit["text"]
            section_rewrites.append(rewrite)

        rewrites[section_name] = section_rewrites

    for section_name in descriptive_sections:
        lines = resume.sections.get(section_name, [])
        if not lines:
            continue

        section_rewrites = []
        for unit in _build_rewrite_units(section_name, lines):
            # For descriptive sections lower the eligibility a bit
            text = unit["text"]
            words = text.split()
            is_eligible = (
                unit["eligible"]
                or (len(words) >= 4 and not _is_header_like(text, section=section_name))
            )
            if is_eligible and not _is_header_like(text, section=section_name):
                frameworks = query_frameworks(text, n_results=2)
                rewrite    = rewrite_bullet(text, frameworks, missing_keywords, provider, local_endpoint, use_critic, model=model)
            else:
                rewrite = {
                    "original":       text,
                    "rewritten":      text,
                    "reasoning":      "Header or label line — no rewrite needed.",
                    "framework_used": "none",
                }
            rewrite["id"] = unit["id"]
            rewrite["section"] = section_name
            rewrite["line_indices"] = unit["line_indices"]
            rewrite["highlight_text"] = text
            section_rewrites.append(rewrite)

        rewrites[section_name] = section_rewrites

    score = compute_score(resume, jd_keywords, missing_keywords, rewrites)

    keyword_frequencies = get_keyword_frequencies(jd_keywords, resume.raw_text)

    # if no JD keywords were found, or JD was missing, just throw a warning 
    no_jd_provided = len(jd_keywords) == 0

    return {
        "contact":          resume.contact,
        "sections":         resume.sections,
        "rewrites":         rewrites,
        "jd_keywords":      jd_keywords,
        "missing_keywords": missing_keywords,
        "keyword_frequencies": keyword_frequencies,
        "score":            score,
        "warnings":         resume.warnings,
        "ocr_used":         resume.ocr_used,
        "no_jd_provided":   no_jd_provided,
    }


def _applied_section_lines(
    section_name: str,
    lines: list[str],
    accepted_rewrites: dict,
    rewrite_suggestions: dict[str, list[dict]] | None,
    rewrite_decisions: dict[str, bool] | None,
) -> tuple[list[str], list[dict], list[dict]]:
    if not rewrite_suggestions or not rewrite_decisions:
        return [accepted_rewrites.get(line, line) for line in lines], [], []

    suggestions = rewrite_suggestions.get(section_name, [])
    by_first_line = {
        item["line_indices"][0]: item
        for item in suggestions
        if item.get("line_indices")
        and item.get("framework_used") not in ("none", "error")
    }

    output_lines: list[str] = []
    accepted_items: list[dict] = []
    dismissed_items: list[dict] = []
    skip_until = -1

    for idx, line in enumerate(lines):
        if idx <= skip_until:
            continue

        item = by_first_line.get(idx)
        decision = rewrite_decisions.get(item.get("id")) if item else None
        if item and decision is True:
            output_lines.append(item.get("rewritten", item.get("original", line)))
            accepted_items.append(item)
            skip_until = max(item.get("line_indices", [idx]))
        else:
            output_lines.append(accepted_rewrites.get(line, line))
            if item and decision is False:
                dismissed_items.append(item)

    return output_lines, accepted_items, dismissed_items


def generate_cv(
    resume: ParsedResume,
    job_description: str,
    accepted_rewrites: dict,
    provider: str,
    local_endpoint: str,
    rewrite_suggestions: dict[str, list[dict]] | None = None,
    rewrite_decisions: dict[str, bool] | None = None,
    model: str = "",
) -> str:
    """Generates a new CV from the resume, optional job description and rewrite decisions."""
    jd_present = bool(job_description.strip())

    # construct resume text using accepted rewrites where applicable
    resume_text = ""
    accepted_items: list[dict] = []
    dismissed_items: list[dict] = []

    if resume.contact:
        resume_text += "=== CONTACT ===\n"
        for k, v in resume.contact.items():
            resume_text += f"{k}: {v}\n"
    
    for section_name, lines in resume.sections.items():
        resume_text += f"\n=== {section_name} ===\n"
        applied_lines, accepted_section, dismissed_section = _applied_section_lines(
            section_name,
            lines,
            accepted_rewrites,
            rewrite_suggestions,
            rewrite_decisions,
        )
        accepted_items.extend(accepted_section)
        dismissed_items.extend(dismissed_section)
        for line in applied_lines:
            resume_text += line + "\n"

    accepted_context = "\n".join(
        f"- {item.get('original')} -> {item.get('rewritten')}"
        for item in accepted_items
    ) or "None"
    dismissed_context = "\n".join(
        f"- {item.get('original')} -> {item.get('rewritten')}"
        for item in dismissed_items
    ) or "None"

    system_prompt = (
        "You are an expert CV writer. Generate a professional, ATS-friendly CV from the candidate's resume. "
        "Use accepted rewrite decisions as the candidate's preferred wording. "
        "Do not apply dismissed rewrite suggestions unless the same improvement is necessary for grammar or clarity. "
        "Never invent employers, dates, credentials, projects, or metrics. "
        "\n\nFORMATTING RULES — follow these exactly:\n"
        "1. Output ONLY the final CV in Markdown format, nothing else.\n"
        "2. The CV MUST fit within 2 pages when rendered at standard margins (A4 or Letter). "
        "This means approximately 600–750 words total. Be concise. Trim low-impact lines, "
        "consolidate redundant bullets, and keep bullet points to one line each.\n"
        "3. Start with the candidate's name as a level-1 heading (# Name).\n"
        "4. Directly below the name, include contact details on a single line separated by ` | `, "
        "e.g. `email@example.com | +65 9123 4567 | linkedin.com/in/...`.\n"
        "5. Each section must start with a level-2 heading (## SECTION NAME) in ALL CAPS.\n"
        "6. After each section heading, add a horizontal rule: `---`.\n"
        "7. Job roles and project titles use level-3 headings or bold+italic (**_Title_**), "
        "with date ranges right-aligned using markdown (put dates on the same line after a `|`).\n"
        "8. All bullet points start with a strong ATS action verb in past tense.\n"
        "9. Limit bullets per role to 2–4 maximum. Cut ruthlessly to stay within 2 pages.\n"
        "10. Sections order: Contact (inline), Summary (if present), Experience, Education, Skills, "
        "Projects (if present), Certifications (if present).\n"
        "11. Do not add any preamble, explanation, or closing note — CV text only."
    )

    jd_block = (
        f"JOB DESCRIPTION:\n{job_description}\n\n"
        if jd_present
        else "JOB DESCRIPTION:\nNone provided. Optimise for clarity, impact, and ATS readability without targeting a specific role.\n\n"
    )
    user_prompt = (
        jd_block +
        f"ACCEPTED REWRITE DECISIONS:\n{accepted_context}\n\n"
        f"DISMISSED REWRITE DECISIONS:\n{dismissed_context}\n\n"
        f"CANDIDATE RESUME:\n{resume_text}\n\n"
        "Generate the complete tailored CV in Markdown format. "
        "CRITICAL: The output must be concise enough to fit within 2 pages (≤ 750 words). "
        "Prioritise impact; cut filler. Every bullet must start with a strong action verb."
    )

    try:
        raw = generate_response(
            user_prompt=user_prompt, 
            system_prompt=system_prompt, 
            provider=provider, 
            local_endpoint=local_endpoint,
            model=model,
            max_tokens=4096
        )
        return raw.strip()
    except Exception as e:
        print(f"CV generation failed: {e}")
        return f"CV generation failed: {e}"


def generate_cover_letter(
    resume: ParsedResume,
    job_description: str,
    provider: str,
    local_endpoint: str,
    model: str = "",
) -> str:
    """Generates a professional cover letter from the candidate's resume and job description."""
    resume_text = resume.to_llm_prompt()

    system_prompt = (
        "You are an expert cover letter writer. Generate a professional, compelling cover letter "
        "that connects the candidate's experience to the target role. "
        "Never invent employers, dates, credentials, projects, or metrics. "
        "\n\nFORMATTING RULES — follow these exactly:\n"
        "1. Output ONLY the cover letter in Markdown format, nothing else.\n"
        "2. The cover letter should be 300–400 words (3–4 paragraphs).\n"
        "3. Start with the candidate's name as a level-1 heading (# Name).\n"
        "4. Below the name, include contact details on a single line separated by ` | `.\n"
        "5. Add today's date on its own line.\n"
        "6. Opening paragraph: Hook the reader, mention the specific role and company if available, "
        "and state why the candidate is an excellent fit.\n"
        "7. Body paragraphs (1–2): Highlight the most relevant experience, skills, and achievements "
        "from the resume that directly align with the job requirements. Use specific examples.\n"
        "8. Closing paragraph: Express enthusiasm, include a call to action, and thank the reader.\n"
        "9. End with 'Sincerely,' followed by the candidate's name.\n"
        "10. Do not add any preamble, explanation, or closing note — cover letter text only."
    )

    jd_block = (
        f"JOB DESCRIPTION:\n{job_description}\n\n"
        if job_description.strip()
        else "JOB DESCRIPTION:\nNone provided. Write a general-purpose cover letter highlighting the candidate's strongest qualifications.\n\n"
    )

    user_prompt = (
        jd_block +
        f"CANDIDATE RESUME:\n{resume_text}\n\n"
        "Generate the complete cover letter in Markdown format. "
        "Keep it concise, professional, and compelling. "
        "Tailor the content specifically to the job description when provided."
    )

    try:
        raw = generate_response(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            provider=provider,
            local_endpoint=local_endpoint,
            model=model,
            max_tokens=2048
        )
        return raw.strip()
    except Exception as e:
        print(f"Cover letter generation failed: {e}")
        return f"Cover letter generation failed: {e}"