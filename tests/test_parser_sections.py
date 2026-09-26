"""Tests for section detection in the parser.

A heading is the section phrase on its own. Lines that merely start with a
section word are content: "Research Assistant" is a job title and
"Technologies: React" is a label with a value. Misreading either used to move
a role's bullets into the wrong section and drop the line itself.
"""

import pytest

from parser import _lines_to_resume, _match_section


@pytest.mark.parametrize("line, expected", [
    ("EXPERIENCE", "EXPERIENCE"),
    ("Work Experience", "EXPERIENCE"),
    ("PROFESSIONAL EXPERIENCE:", "EXPERIENCE"),
    ("E X P E R I E N C E", "EXPERIENCE"),
    ("## Education", "EDUCATION"),
    ("Skills & Interests", "SKILLS"),
    ("Education and Training", "EDUCATION"),
    ("Awards and Certifications", "AWARDS"),
    ("WORKEXPERIENCE", "EXPERIENCE"),
    ("Selected Publications", "PUBLICATIONS"),
    ("Industry Experience", "EXPERIENCE"),
    ("TECHNICAL SKILLS —", "SKILLS"),
    ("Projects 2", "PROJECTS"),
    ("Skills & Abilities", "SKILLS"),
    ("Skills Summary", "SKILLS"),
    ("Summary of Qualifications", "SUMMARY"),
    ("Experience (Selected)", "EXPERIENCE"),
    ("References available on request", "REFERENCES"),
])
def test_headings_are_recognised(line, expected):
    assert _match_section(line) == expected


@pytest.mark.parametrize("line", [
    "Research Assistant",
    "Research Assistant, NUS Computing | 2022 - 2023",
    "Head of Research",
    "Director of Research",
    "Technologies: React, Node.js, PostgreSQL",
    "Experience with Python and Java in production",
    "Projects Coordinator",
    "Education Consultant at Acme",
    "Research & Development",
    "Skills Development Officer",
    "Research Engineer",
    "Portfolio Manager at BlackRock",
    "Research at NUS",
])
def test_content_lines_are_not_headings(line):
    assert _match_section(line) is None


def _parse(lines):
    return _lines_to_resume(lines).sections


def test_a_research_job_title_stays_with_its_role():
    sections = _parse([
        "Jane Doe",
        "EXPERIENCE",
        "Research Assistant",
        "NUS School of Computing | 2022 - 2023",
        "- Built a data pipeline for lab experiments",
        "EDUCATION",
        "BSc Computer Science, 2023",
    ])
    assert "PUBLICATIONS" not in sections
    assert sections["EXPERIENCE"][0] == "Research Assistant"
    assert "- Built a data pipeline for lab experiments" in sections["EXPERIENCE"]


def test_a_tech_stack_label_stays_in_its_project():
    sections = _parse([
        "PROJECTS",
        "Resume Analyser",
        "Technologies: React, Node.js, PostgreSQL",
        "- Built a parser for PDF resumes",
    ])
    assert "SKILLS" not in sections
    assert "Technologies: React, Node.js, PostgreSQL" in sections["PROJECTS"]
    assert "- Built a parser for PDF resumes" in sections["PROJECTS"]


def test_an_inline_section_keeps_its_value():
    sections = _parse([
        "EDUCATION",
        "BSc Computer Science, 2023",
        "Skills: Python, Go, Kubernetes",
    ])
    assert sections["SKILLS"] == ["Python, Go, Kubernetes"]


def test_a_sublabel_stays_inside_skills():
    sections = _parse([
        "SKILLS",
        "Languages: Python, Go",
        "Frameworks: React, Flask",
    ])
    assert sections == {"SKILLS": ["Languages: Python, Go", "Frameworks: React, Flask"]}


def test_a_summary_sentence_does_not_start_experience():
    sections = _parse([
        "SUMMARY",
        "Experience with Python and Java in production",
        "EXPERIENCE",
        "- Built the billing service",
    ])
    assert sections["SUMMARY"] == ["Experience with Python and Java in production"]
    assert sections["EXPERIENCE"] == ["- Built the billing service"]


def test_a_heading_wrapped_over_two_lines_still_matches():
    sections = _parse(["WORK", "EXPERIENCE", "- Built the billing service"])
    assert sections["EXPERIENCE"] == ["- Built the billing service"]
