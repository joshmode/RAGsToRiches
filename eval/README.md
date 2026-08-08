# Claim detector evaluation

Measures whether the deterministic claim guards actually work, which the critic
benchmark never did — that one measures cost and trigger rate, not correctness.

```bash
python eval_claims.py                                   # tuned set
python eval_claims.py --set eval/claim_eval_holdout.json # held-out set
python eval_claims.py --json                             # machine-readable
```

## The two sets

| File | Cases | Purpose |
|---|---|---|
| `claim_eval_set.json` | 50 | Development set. Bugs it found were fixed, so its scores are optimistic by construction. |
| `claim_eval_holdout.json` | 20 | Written to probe the general rules and **never tuned against**. The honest number. |

Labels record human judgement of the pair alone, independent of what the code
does. A disagreement is a measurement, not a fixture bug.

- `invented_metric` — the rewrite asserts a quantity the original did not support
- `role_escalation` — the rewrite claims more responsibility than the original stated

## Results

Development set (50 cases):

| Detector | Precision | Recall | F1 |
|---|---|---|---|
| `invented_metric` | 1.00 | 1.00 | 1.00 |
| `role_escalation` | 1.00 | 1.00 | 1.00 |
| any fabrication | 1.00 | 1.00 | 1.00 |

Held-out set (20 cases), never tuned against:

| Detector | Precision | Recall | F1 |
|---|---|---|---|
| `invented_metric` | 0.83 | 0.71 | 0.77 |
| `role_escalation` | 1.00 | 0.57 | 0.73 |
| any fabrication | 0.90 | 0.64 | 0.75 |

**The gap between the two is the point.** 1.00 on the set the code was fixed
against and 0.64 on the set it was not is what tuning to an eval looks like, and
it is why the held-out split exists. Only the second table is a real result.

## What the held-out set shows it misses

Every miss falls into one of three families, and all three are why the LLM critic
is still in the pipeline:

- **Quantities with no digits** — "Doubled throughput", "by forty percent". The
  regex sees numerals; an implicit multiplier or a spelled-out figure is invisible.
- **Escalation the leading verb cannot see** — "Was on the team that shipped the
  API" becoming "Shipped the API" is a credit shift with no verb-tier move.
- **Verbs outside the ladder** — "Presented" to "Keynoted" is a real escalation
  between two verbs the ladder does not grade.

The one false positive is symmetric: "a couple of teams" rewritten as "2 teams"
is the same claim, but "couple" is not in the number-word map.

## Rules

1. **Never tune against the held-out set.** If a change is made because of a
   held-out failure, that case has stopped being held out — move it to the
   development set and write a new held-out case.
2. **Re-run both after any prompt or detector change.** `tests/test_prompt_versions.py`
   fails on a prompt edit precisely to force this.
3. **Report both numbers**, not the flattering one.
