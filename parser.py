import fitz
import re
import numpy as np
from dataclasses import dataclass, field

try:
    import easyocr
    import pdf2image
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False

# easyocr Reader only initialised once 
_reader = None

def _get_reader():
    global _reader
    if _reader is None:
        _reader = easyocr.Reader(["en"], gpu=False)  # set gpu=True if you have CUDA
    return _reader


EMAIL_RE    = re.compile(r'[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}')
PHONE_RE    = re.compile(r'(\+?\d[\d\s\-().]{7,}\d)')
LINKEDIN_RE = re.compile(r'linkedin\.com/in/[\w\-]+', re.IGNORECASE)
GITHUB_RE   = re.compile(r'github\.com/[\w\-]+', re.IGNORECASE)
URL_RE      = re.compile(r'https?://\S+')

#map headers to aliases
SECTION_ALIASES = {
    "experience":              "EXPERIENCE",
    "work experience":         "EXPERIENCE",
    "professional experience": "EXPERIENCE",
    "employment history":      "EXPERIENCE",
    "work history":            "EXPERIENCE",
    "internships":             "EXPERIENCE",
    "internship experience":   "EXPERIENCE",
    "relevant experience":     "EXPERIENCE",
    "career history":          "EXPERIENCE",

    "education":               "EDUCATION",
    "academic background":     "EDUCATION",
    "qualifications":          "EDUCATION",
    "academic qualifications": "EDUCATION",

    "skills":                  "SKILLS",
    "technical skills":        "SKILLS",
    "core competencies":       "SKILLS",
    "technologies":            "SKILLS",
    "tools & technologies":    "SKILLS",
    "tools and technologies":  "SKILLS",
    "key skills":              "SKILLS",
    "competencies":            "SKILLS",
    "technical competencies":  "SKILLS",
    "areas of expertise":      "SKILLS",
    "skill set":               "SKILLS",

    "projects":                "PROJECTS",
    "personal projects":       "PROJECTS",
    "side projects":           "PROJECTS",
    "portfolio":               "PROJECTS",
    "key projects":            "PROJECTS",
    "academic projects":       "PROJECTS",
    "relevant projects":       "PROJECTS",
    "selected projects":       "PROJECTS",
    "project experience":      "PROJECTS",
    "notable projects":        "PROJECTS",

    "summary":                 "SUMMARY",
    "professional summary":    "SUMMARY",
    "profile":                 "SUMMARY",
    "objective":               "SUMMARY",
    "about me":                "SUMMARY",
    "career objective":        "SUMMARY",
    "career summary":          "SUMMARY",
    "executive summary":       "SUMMARY",
    "personal statement":      "SUMMARY",

    "certifications":          "CERTIFICATIONS",
    "certificates":            "CERTIFICATIONS",
    "licenses":                "CERTIFICATIONS",
    "licenses & certifications": "CERTIFICATIONS",
    "professional certifications": "CERTIFICATIONS",

    "awards":                  "AWARDS",
    "honors":                  "AWARDS",
    "achievements":            "AWARDS",
    "honors & awards":         "AWARDS",
    "awards & recognition":    "AWARDS",

    "publications":            "PUBLICATIONS",
    "research":                "PUBLICATIONS",
    "research experience":     "PUBLICATIONS",
    "papers":                  "PUBLICATIONS",

    "volunteer":               "VOLUNTEER",
    "volunteering":            "VOLUNTEER",
    "community":               "VOLUNTEER",
    "community service":       "VOLUNTEER",
    "volunteer experience":    "VOLUNTEER",
    "community involvement":   "VOLUNTEER",

    "languages":               "LANGUAGES",
    "interests":               "INTERESTS",
    "hobbies":                 "INTERESTS",
    "activities":              "INTERESTS",
    "extracurricular":         "INTERESTS",
    "extracurricular activities": "INTERESTS",
    "references":              "REFERENCES",
}

# Strip markdown bold/italic markers and other formatting issues from PDF extraction
_MARKDOWN_STRIP_RE = re.compile(r'[\*_#`]+')
# Strip common decorative chars that PDF extractors sometimes leave
_DECORATION_RE = re.compile(r'^[\s\u200b\ufeff\u00a0│|▌►▶◆■□●○]+|[\s\u200b\ufeff\u00a0│|▌►▶◆■□●○]+$')


def _clean_section_candidate(line: str) -> str:
    """Clean a line for section header matching — strips formatting artifacts."""
    cleaned = _MARKDOWN_STRIP_RE.sub('', line)
    cleaned = _DECORATION_RE.sub('', cleaned)
    cleaned = cleaned.strip()
    # Remove trailing colon/dash/pipe that may be part of the header style
    cleaned = re.sub(r'[\s:;\-–—|]+$', '', cleaned)
    return cleaned


# Build the regex from aliases
_SECTION_RE = re.compile(
    r'^(' + '|'.join(re.escape(k) for k in sorted(SECTION_ALIASES.keys(), key=len, reverse=True)) + r')\b.*$',
    re.IGNORECASE,
)

# Single word canonical section names for fuzzy fallback
_CANONICAL_STARTERS = {
    word.split()[0].lower()
    for word in SECTION_ALIASES.keys()
    if len(word.split()) == 1
}
# Add multi-word starters too
_CANONICAL_STARTERS.update({
    "work", "professional", "employment", "career",
    "technical", "core", "key", "academic", "personal",
    "side", "selected", "notable", "relevant",
    "volunteer", "community", "extracurricular",
})


@dataclass
class ParsedResume:
    raw_text: str = ""
    contact:  dict = field(default_factory=dict)
    sections: dict[str, list[str]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    ocr_used: bool = False

    def section_text(self, name: str) -> str:
        return "\n".join(self.sections.get(name.upper(), []))

    def to_llm_prompt(self) -> str:
        parts = [] #use a list to store the various parts of the parsed resume
        if self.contact:
            parts.append("=== CONTACT ===")
            for key, val in self.contact.items():
                parts.append(f"{key}: {val}")
        for section, lines in self.sections.items():
            parts.append(f"\n=== {section} ===")
            parts.extend(lines)
        return "\n".join(parts)


def _is_scanned(lines: list[str]) -> bool:
    useful = [l for l in lines if len(l.strip()) > 3]
    return len(useful) < 10

def _ocr_fallback(raw: bytes) -> list[str]:
    if not OCR_AVAILABLE:
        return []

    reader = _get_reader() 
    images = pdf2image.convert_from_bytes(raw, dpi=300) # pdf2image gives us one image per page
    all_lines = []
    for img in images:
        # easyocr needs a numpy array
        img_array = np.array(img)

        # we sort by vertical position so lines come out in reading order
        results = reader.readtext(img_array, detail=1, paragraph=False) #detail = 1 gives confidence sccores
        results.sort(key=lambda r: r[0][0][1])  # sort by top-left y coordinate

        for (bbox, text, confidence) in results:
            cleaned = text.strip()
            # cleans all noise out 
            if confidence > 0.3 and len(cleaned) > 2:
                all_lines.append(cleaned)

    return all_lines


def _extract_blocks_sorted(page: fitz.Page) -> list[str]:
    # sort by the row bucket then x so 2-column layouts don't get scrambled
    blocks = page.get_text("blocks")
    text_blocks = [b for b in blocks if b[6] == 0]
    text_blocks.sort(key=lambda b: (round(b[1] / 10), b[0]))

    lines = []
    for block in text_blocks:
        for raw_line in block[4].split("\n"):
            stripped = raw_line.strip()
            if stripped:
                lines.append(stripped)
    return lines


def _detect_section(line: str) -> str | None:
    # First clean the line of formatting issues
    cleaned = _clean_section_candidate(line)
    if not cleaned:
        return None

    # Exact match against known aliases 
    m = _SECTION_RE.match(cleaned)
    if m:
        return SECTION_ALIASES[m.group(1).lower()]

    # Direct lowercase lookup
    lower = cleaned.lower().strip()
    if lower in SECTION_ALIASES:
        return SECTION_ALIASES[lower]

    # Strip trailing colon/numbers then retry exact lookup
    stripped_lower = re.sub(r'[\s:;\-–—|]+$', '', lower).strip()
    stripped_lower = re.sub(r'\s*\d+\s*$', '', stripped_lower).strip()
    if stripped_lower in SECTION_ALIASES:
        return SECTION_ALIASES[stripped_lower]

    # Fuzzy fallback
    words = cleaned.split()
    if 1 <= len(words) <= 8:
        first_word = words[0].lower().rstrip(':')
        is_stylized = (
            cleaned.isupper()
            or cleaned.istitle()
            or (len(words) <= 5 and all(w[0].isupper() for w in words if w and w[0].isalpha()))
            or cleaned.replace(' ', '').isupper()
        )
        if first_word in _CANONICAL_STARTERS and is_stylized:
            for n in range(len(words), 0, -1):
                candidate = ' '.join(w.lower().rstrip(':') for w in words[:n])
                if candidate in SECTION_ALIASES:
                    return SECTION_ALIASES[candidate]

        # Last resort: even if not stylised
        for n in range(min(len(words), 4), 0, -1):
            candidate = ' '.join(w.lower().rstrip(':') for w in words[:n])
            if candidate in SECTION_ALIASES:
                remaining = words[n:]
                if not remaining or all(not re.search(r'[.!?]', w) for w in remaining):
                    return SECTION_ALIASES[candidate]
                
        if 1 <= len(words) <= 6:
            last_word = words[-1].lower().rstrip(':')
            is_stylized = (
                cleaned.istitle()
                or cleaned.isupper()
                or all(w[0].isupper() for w in words if w and w[0].isalpha())
            )
            if last_word in SECTION_ALIASES and is_stylized:
                return SECTION_ALIASES[last_word]

        return None


def _extract_contact(lines: list[str]) -> dict:
    contact = {}
    for i, line in enumerate(lines[:15]):
        if i == 0 and not EMAIL_RE.search(line) and not PHONE_RE.search(line):
            contact["name"] = line

        if "email" not in contact:
            m = EMAIL_RE.search(line)
            if m:
                contact["email"] = m.group()

        if "phone" not in contact:
            m = PHONE_RE.search(line)
            if m:
                digits = re.sub(r'\D', '', m.group())
                if len(digits) >= 7:
                    contact["phone"] = m.group().strip()

        if "linkedin" not in contact:
            m = LINKEDIN_RE.search(line)
            if m:
                contact["linkedin"] = m.group()

        if "github" not in contact:
            m = GITHUB_RE.search(line)
            if m:
                contact["github"] = m.group()

        if "website" not in contact:
            m = URL_RE.search(line)
            if m and "linkedin" not in m.group() and "github" not in m.group():
                contact["website"] = m.group()

    return contact


def extract_text(pdf_file) -> ParsedResume:
    result = ParsedResume()
    raw = pdf_file.read() if hasattr(pdf_file, "read") else pdf_file

    try:
        doc = fitz.open(stream=raw, filetype="pdf")
    except Exception as e:
        result.warnings.append(f"couldn't open PDF: {e}")
        return result

    all_lines: list[str] = []
    for page in doc:
        all_lines.extend(_extract_blocks_sorted(page))
    doc.close()

    if _is_scanned(all_lines):
        if not OCR_AVAILABLE:
            result.warnings.append("PDF appears scanned but easyocr isn't installed. \n Run: pip install easyocr pdf2image Pillow numpy \n Also install poppler for pdf2image, open README for instructions")
            return result

        result.warnings.append("No readable text found, running OCR. Please wait as the module loads.")
        all_lines = _ocr_fallback(raw)
        result.ocr_used = True

        if not all_lines:
            result.warnings.append("OCR couldn't parse text. PDF may be corrupt or excessively styled.")
            return result

    result.raw_text = "\n".join(all_lines)
    result.contact  = _extract_contact(all_lines)

    sections: dict[str, list[str]] = {"HEADER": []}
    current = "HEADER"

    for line in all_lines:
        canonical = _detect_section(line)
        if canonical:
            current = canonical
            if current not in sections:
                sections[current] = []
        else:
            sections[current].append(line)

    contact_values = set(result.contact.values())
    sections["HEADER"] = [
        l for l in sections.get("HEADER", [])
        if l not in contact_values
        and not EMAIL_RE.search(l)
        and not PHONE_RE.search(l)
        and not LINKEDIN_RE.search(l)
        and not GITHUB_RE.search(l)
    ]

    result.sections = {k: v for k, v in sections.items() if v}

    for must_have in ("EXPERIENCE", "EDUCATION", "SKILLS"):
        if must_have not in result.sections:
            result.warnings.append(f"'{must_have}' section not detected: the header might not be interpretable, please check your resume accordingly.")

    return result
