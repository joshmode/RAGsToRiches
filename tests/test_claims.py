"""Unit tests for the deterministic claim checks.

These cover the two fabrication classes the rewrite pipeline guards against, and
in particular the conservative behaviour of the qualitative check: it must never
flag a rewrite the original already justified.
"""

import claims


# ---------------------------------------------------------------- quantitative

def test_extracts_numbers_percentages_and_amounts():
    found = claims.quantitative_claims("Cut latency 40% and saved $2000 with a 3x speedup")
    assert "40%" in found
    assert "$2000" in found
    assert "3x" in found


def test_counted_nouns_are_claims():
    assert "10 users" in claims.quantitative_claims("Served 10 users")
    assert "6 months" in claims.quantitative_claims("Ran for 6 months")


def test_bare_years_are_dates_not_metrics():
    assert claims.quantitative_claims("Worked there from 2019 to 2023") == set()


def test_placeholders_are_not_claims():
    # The rewrite prompt asks for these when a metric is missing, so they are the
    # honest output and must never be counted as an invention.
    assert claims.quantitative_claims("Improved conversion by [X%] for [N users]") == set()
    assert claims.quantitative_claims("Improved conversion by [40%]") == set()


def test_new_claim_is_detected():
    assert claims.has_new_claims(
        "Worked on the checkout system",
        "Improved checkout conversion by 40%",
    )


def test_repeating_an_existing_claim_is_not_new():
    assert not claims.has_new_claims(
        "Cut p95 latency by 40%",
        "Reduced p95 latency 40% by batching predictions",
    )


def test_dropping_a_claim_is_not_new():
    assert not claims.has_new_claims("Cut latency by 40%", "Cut latency substantially")


def test_new_quantitative_claims_reports_the_offending_tokens():
    assert claims.new_quantitative_claims(
        "Led the rollout",
        "Led the rollout to 500 users, cutting cost 20%",
    ) == {"500 users", "20%"}


# ----------------------------------------------------------------- leading verb

def test_leading_verb_grades_a_single_word():
    assert claims.leading_verb("Led the migration") == ("led", claims.OWNERSHIP)
    assert claims.leading_verb("Built the API") == ("built", claims.EXECUTION)
    assert claims.leading_verb("Helped the team") == ("helped", claims.PARTICIPATION)


def test_leading_verb_grades_multiword_openers():
    assert claims.leading_verb("Worked on the checkout flow")[1] == claims.PARTICIPATION
    assert claims.leading_verb("Was responsible for reporting")[1] == claims.PARTICIPATION
    assert claims.leading_verb("In charge of the release")[1] == claims.OWNERSHIP


def test_leading_verb_ignores_bullet_prefixes():
    assert claims.leading_verb("- Led the migration") == ("led", claims.OWNERSHIP)
    assert claims.leading_verb("• Led the migration") == ("led", claims.OWNERSHIP)
    assert claims.leading_verb("1. Led the migration") == ("led", claims.OWNERSHIP)


def test_ungraded_opener_returns_no_tier():
    verb, tier = claims.leading_verb("Frobnicated the widget")
    assert verb == "frobnicated"
    assert tier is None


def test_empty_text_has_no_leading_verb():
    assert claims.leading_verb("") == (None, None)
    assert claims.leading_verb("   ") == (None, None)


def test_max_tier_scans_the_whole_sentence():
    assert claims.max_tier_in("Supported the migration I led") == claims.OWNERSHIP
    assert claims.max_tier_in("Helped the team") == claims.PARTICIPATION
    assert claims.max_tier_in("Frobnicated the widget") == -1


# ------------------------------------------------------------ verb escalation

def test_participation_to_ownership_is_flagged():
    finding = claims.verb_escalation(
        "Helped with the database migration",
        "Led the database migration",
    )
    assert finding is not None
    assert finding["from"] == "helped with"
    assert finding["to"] == "led"
    assert finding["from_tier"] == "participation"
    assert finding["to_tier"] == "ownership"


def test_execution_to_ownership_is_flagged():
    assert claims.verb_escalation("Built the API", "Architected the API") is not None


def test_participation_to_execution_is_flagged():
    assert claims.verb_escalation(
        "Worked on the checkout system",
        "Built the checkout system",
    ) is not None


def test_same_tier_is_not_an_escalation():
    assert claims.verb_escalation("Led the team", "Managed the team") is None
    assert claims.verb_escalation("Built the API", "Developed the API") is None


def test_downgrade_is_not_an_escalation():
    assert claims.verb_escalation("Led the team", "Helped the team") is None


def test_original_already_evidencing_the_tier_suppresses_the_finding():
    # "Supported the migration I led" already claims ownership, so opening the
    # rewrite with "Led" is a rephrasing, not a new claim.
    assert claims.verb_escalation(
        "Supported the migration I led",
        "Led the database migration",
    ) is None


def test_ungraded_verb_on_either_side_suppresses_the_finding():
    assert claims.verb_escalation("Frobnicated the widget", "Led the widget") is None
    assert claims.verb_escalation("Helped the team", "Frobnicated the widget") is None


def test_escalation_survives_bullet_prefixes():
    assert claims.verb_escalation("- helped with X", "• Led X") is not None


def test_identical_text_is_never_an_escalation():
    text = "Led the database migration"
    assert claims.verb_escalation(text, text) is None


# ------------------------------------------------------------------- findings

def test_findings_reports_both_classes_together():
    result = claims.findings(
        "Helped with the checkout system",
        "Led the checkout rebuild, lifting conversion 40%",
    )
    assert result["new_quantitative_claims"] == ["40%"]
    assert result["verb_escalation"] is not None
    assert result["clean"] is False


def test_findings_clean_for_an_honest_rewrite():
    result = claims.findings(
        "Worked on the checkout system",
        "Rebuilt the checkout system, improving conversion by [X%]",
    )
    assert result["new_quantitative_claims"] == []
    assert result["clean"] is False  # participation -> execution is still a claim


def test_findings_fully_clean_when_nothing_changed_in_substance():
    result = claims.findings(
        "Built the checkout system",
        "Rebuilt the checkout system for clarity",
    )
    assert result["clean"] is True
