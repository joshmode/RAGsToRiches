"""Reading order for PDF layouts.

A two-column resume used to be read row by row across the whole page, so a line
from the left column was followed by the line beside it in the right column.
Both columns' headings landed on the first row and whole sections vanished.
"""

import fitz

from parser import parse_pdf

LEFT = [
    "EXPERIENCE",
    "Software Engineer, Acme Corp",
    "2021 - 2023",
    "- Built the billing service used by 40 teams",
    "- Cut deploy time by 30% with a new CI pipeline",
    "Data Intern, Beta Labs",
    "- Cleaned survey data for the research team",
    "PROJECTS",
    "- Wrote a budgeting app with 2,000 monthly users",
]
RIGHT = [
    "EDUCATION",
    "BSc Computer Science",
    "National University, 2021",
    "SKILLS",
    "Python, Go, SQL",
    "Docker, Kubernetes",
]


def _pdf(draw) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    draw(page)
    data = doc.tobytes()
    doc.close()
    return data


def _column(page, x, lines, top=130):
    for i, line in enumerate(lines):
        page.insert_text((x, top + i * 16), line, fontsize=10)


def _two_columns(page):
    # a centred name and contact line over both columns
    page.insert_text((250, 60), "Jane Doe", fontsize=18)
    page.insert_text((215, 82), "jane@example.com | 555-0100", fontsize=10)
    _column(page, 40, LEFT)
    _column(page, 360, RIGHT)


def test_two_columns_keep_their_sections():
    resume = parse_pdf(_pdf(_two_columns))
    assert resume.sections["EXPERIENCE"][:2] == ["Software Engineer, Acme Corp", "2021 - 2023"]
    assert "- Cut deploy time by 30% with a new CI pipeline" in resume.sections["EXPERIENCE"]
    assert resume.sections["EDUCATION"] == ["BSc Computer Science", "National University, 2021"]
    assert resume.sections["SKILLS"] == ["Python, Go, SQL", "Docker, Kubernetes"]
    assert resume.sections["PROJECTS"] == ["- Wrote a budgeting app with 2,000 monthly users"]
    assert not any("not detected" in w for w in resume.warnings)


def test_a_full_width_heading_between_columns_keeps_its_place():
    def draw(page):
        _column(page, 40, LEFT[:4], top=80)
        _column(page, 360, RIGHT[:3], top=80)
        page.insert_text((40, 180), "VOLUNTEER EXPERIENCE AND COMMUNITY WORK ACROSS SEVERAL YEARS", fontsize=10)
        _column(page, 40, ["- Tutored maths at a community centre"], top=200)
        _column(page, 360, ["LANGUAGES", "English, Malay"], top=200)
    resume = parse_pdf(_pdf(draw))
    lines = resume.raw_text.splitlines()
    assert lines.index("BSc Computer Science") < lines.index("VOLUNTEER EXPERIENCE AND COMMUNITY WORK ACROSS SEVERAL YEARS")
    assert lines.index("- Tutored maths at a community centre") < lines.index("LANGUAGES")


def test_right_aligned_dates_are_not_a_column():
    def draw(page):
        page.insert_text((40, 60), "Jane Doe", fontsize=18)
        page.insert_text((40, 100), "EXPERIENCE", fontsize=10)
        rows = [
            ("Software Engineer, Acme Corp", "2021 - 2023"),
            ("Data Intern, Beta Labs", "Jun 2020 - Aug 2020"),
            ("Research Assistant, NUS", "2019 - 2020"),
        ]
        y = 118
        for title, dates in rows:
            page.insert_text((40, y), title, fontsize=10)
            page.insert_text((480, y), dates, fontsize=10)
            page.insert_text((40, y + 14), "- Built and shipped internal tooling for the team that owns payments", fontsize=10)
            y += 34
    resume = parse_pdf(_pdf(draw))
    experience = resume.sections["EXPERIENCE"]
    assert experience[:3] == [
        "Software Engineer, Acme Corp",
        "2021 - 2023",
        "- Built and shipped internal tooling for the team that owns payments",
    ]
