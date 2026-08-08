"""Measure the deterministic claim detectors against the labelled eval set.

The critic benchmark answers "what does the guard cost". This answers the
question that was missing: "does the guard work". It reports precision, recall
and F1 per detector, and prints every disagreement so the failure modes are
inspectable rather than aggregated away.

False positives matter as much as misses here. A detector that flags an honest
rewrite costs the candidate good work, so both directions are reported.

Runs offline against ``claims.py`` alone: no model, no vector store, no API key.

    python eval_claims.py
    python eval_claims.py --show-agreements
    python eval_claims.py --min-recall 0.7 --min-precision 0.9
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass

import claims

DEFAULT_SET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "eval", "claim_eval_set.json")


@dataclass
class Outcome:
    true_positive: int = 0
    false_positive: int = 0
    false_negative: int = 0
    true_negative: int = 0

    @property
    def precision(self) -> float:
        denominator = self.true_positive + self.false_positive
        return self.true_positive / denominator if denominator else 1.0

    @property
    def recall(self) -> float:
        denominator = self.true_positive + self.false_negative
        return self.true_positive / denominator if denominator else 1.0

    @property
    def f1(self) -> float:
        if self.precision + self.recall == 0:
            return 0.0
        return 2 * self.precision * self.recall / (self.precision + self.recall)

    @property
    def total(self) -> int:
        return self.true_positive + self.false_positive + self.false_negative + self.true_negative

    def record(self, predicted: bool, actual: bool) -> str:
        if predicted and actual:
            self.true_positive += 1
            return "TP"
        if predicted and not actual:
            self.false_positive += 1
            return "FP"
        if actual:
            self.false_negative += 1
            return "FN"
        self.true_negative += 1
        return "TN"


DETECTORS = {
    "invented_metric": lambda original, rewritten: claims.has_new_claims(original, rewritten),
    "role_escalation": lambda original, rewritten: claims.verb_escalation(original, rewritten) is not None,
}


def load_cases(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    cases = payload["cases"] if isinstance(payload, dict) else payload
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"{path} contains no cases")
    return cases


def evaluate(cases: list[dict]) -> tuple[dict[str, Outcome], Outcome, list[dict]]:
    per_detector = {name: Outcome() for name in DETECTORS}
    combined = Outcome()
    disagreements: list[dict] = []

    for case in cases:
        original, rewritten = case["original"], case["rewritten"]
        predicted_any = False
        actual_any = False

        for name, detect in DETECTORS.items():
            predicted = bool(detect(original, rewritten))
            actual = bool(case["labels"][name])
            verdict = per_detector[name].record(predicted, actual)
            predicted_any = predicted_any or predicted
            actual_any = actual_any or actual
            if verdict in ("FP", "FN"):
                disagreements.append({
                    "id": case["id"], "detector": name, "verdict": verdict,
                    "original": original, "rewritten": rewritten,
                    "note": case.get("note", ""),
                })

        combined.record(predicted_any, actual_any)

    return per_detector, combined, disagreements


def _row(label: str, outcome: Outcome) -> str:
    return (
        f"  {label:<18} "
        f"P {outcome.precision:5.2f}  R {outcome.recall:5.2f}  F1 {outcome.f1:5.2f}   "
        f"TP {outcome.true_positive:>3} FP {outcome.false_positive:>3} "
        f"FN {outcome.false_negative:>3} TN {outcome.true_negative:>3}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", dest="path", default=DEFAULT_SET)
    parser.add_argument("--min-recall", type=float, default=None)
    parser.add_argument("--min-precision", type=float, default=None)
    parser.add_argument("--show-agreements", action="store_true")
    parser.add_argument("--json", action="store_true", help="emit machine-readable results")
    args = parser.parse_args()

    cases = load_cases(args.path)
    per_detector, combined, disagreements = evaluate(cases)

    if args.json:
        print(json.dumps({
            "cases": len(cases),
            "detectors": {
                name: {
                    "precision": round(outcome.precision, 4),
                    "recall": round(outcome.recall, 4),
                    "f1": round(outcome.f1, 4),
                    "tp": outcome.true_positive, "fp": outcome.false_positive,
                    "fn": outcome.false_negative, "tn": outcome.true_negative,
                }
                for name, outcome in per_detector.items()
            },
            "any_fabrication": {
                "precision": round(combined.precision, 4),
                "recall": round(combined.recall, 4),
                "f1": round(combined.f1, 4),
            },
            "disagreements": disagreements,
        }, indent=2))
    else:
        print(f"\nDeterministic claim detectors — {len(cases)} labelled cases\n")
        for name, outcome in per_detector.items():
            print(_row(name, outcome))
        print(_row("any fabrication", combined))

        if disagreements:
            print(f"\n{len(disagreements)} disagreement(s) with the labels:\n")
            for item in disagreements:
                kind = "missed" if item["verdict"] == "FN" else "wrongly flagged"
                print(f"  [{item['verdict']}] {item['id']} ({item['detector']}) — {kind}")
                print(f"        from: {item['original']}")
                print(f"          to: {item['rewritten']}")
                if item["note"]:
                    print(f"        note: {item['note']}")
        else:
            print("\nNo disagreements with the labels.")

        if args.show_agreements:
            print("\nEvery case agreed with its label except those listed above.")

    failed = False
    for name, outcome in per_detector.items():
        if args.min_recall is not None and outcome.recall < args.min_recall:
            print(f"\nFAIL: {name} recall {outcome.recall:.2f} < {args.min_recall:.2f}", file=sys.stderr)
            failed = True
        if args.min_precision is not None and outcome.precision < args.min_precision:
            print(f"\nFAIL: {name} precision {outcome.precision:.2f} < {args.min_precision:.2f}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        # Something downstream closed the pipe first, e.g. `| head`. Redirect the
        # remaining output so Python does not report the broken pipe on exit.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        raise SystemExit(0)
