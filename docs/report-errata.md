# What's changed since the Milestone 3 report

[`7656_README_Milestone3.pdf`](7656_README_Milestone3.pdf) describes the project as it
stood at Milestone 3. The code has moved on since, mostly in response to a review of
where the report's claims and the implementation disagreed. This page lists where the
report no longer matches the code, by report section. The report itself is left as it
was submitted.

## Scoring (§0.7.3, §7.12, §8.3.3)

**The report says:** `calc_score` starts from a base of 30, adds points for each major
section present, for job keyword coverage, for bullet quality taken from the model's
severity ratings and for action verbs, and adjusts the score for accepted rewrites.
§0.7.3 describes it as an LLM agent.

**The code does:** a fixed rubric reads only the candidate's own bullets, with no model
involved (`scoring.py`). Each bullet in a graded section (Experience, Projects,
Volunteer, Leadership) is checked for a quantified result (40 points), an action-verb
opening (30) and clean structure: length, no first person, no filler (30). The total is
the average over those bullets.

- There are no base points, no points for having a heading, and no keyword points.
- The model's rewrite, and its opinion of the bullet, can't move the score. Accepting a
  rewrite changes the score only when the revised resume is uploaded.
- Sections the rubric can't grade, such as Skills, show as "Not graded" instead of 100%.
- The score is known as soon as the file is parsed, and the upload screen shows it
  before any analysis runs.

**Why:** the old score gave free points and measured the AI's opinion of the resume
rather than the resume.

## Job fit and ATS keywords (§0.7, §7.13, §14)

**The report says:** a "semantic" ATS analysis sends both documents to a model, which
returns a match percentage and the skill gaps.

**The code does:** one model call reads the job description for its keywords, the
company and a few tips (`job_fit.py`). The read is cached for a day by a hash of the
description. The match percentage is the share of those keywords that appear in the
resume, computed without a model, so it can't disagree with the keyword lists beside
it. The analysis, the Job Fit tab and "Check another job" all use the same read.

## Keywords in rewrites (§7.8)

**The report says:** the rewrite prompt includes "ATS KEYWORDS TO WEAVE IN NATURALLY".

**The code does:** a bullet is offered a job keyword only when its own content already
supports it (`weaving.py`). That means it names the keyword another way ("Postgres"
for PostgreSQL), names a tool that entails it (Flask for Python, GitHub Actions for
CI/CD), or says the same thing in other words ("reviewed code" for code review). Any
other job keyword a rewrite adds is flagged for the candidate to check, and the review
shows which keywords a rewrite worked in and why.

**Why:** handing every rewrite the missing keywords invented experience the candidate
never claimed.

## Checking rewrites for invented claims (§7.7.2, §7.17, §14.2)

**The report says:** an optional critic pass repairs or rejects problematic rewrites.

**The code does:** these checks run on every rewrite, whether or not the critic is on
(`claims.py`):

- a regex for figures that aren't in the original;
- a verb ladder for inflated roles ("helped with" becoming "led");
- the job-keyword check above.

The critic, when on, judges the figures a check flags and audits whole batches for
overstated scope, credit or invented tools. A rewrite the critic can't repair falls back
to the candidate's original bullet.

Findings are shown on each suggestion. "Accept all" and Job Fit's tailored CV leave
flagged rewrites out for the candidate to decide one by one. The framework guides the
model retrieves no longer contain example figures it could copy, only placeholders
such as `[X%]`.

## Model routing (§7.7)

**The report says:** failed calls are retried up to five times with exponential backoff.

**The code does:** provider SDK retries are off, and one deadline covers the whole
analysis (`ANALYSIS_DEADLINE_SECONDS`, 240 by default), every retry and fallback
included. A fallback is skipped when there isn't time left for it. Each analysis records
the model that actually answered. OpenRouter's free pool is still the default tier.

## PDF highlighting (§5, §7, §9, §10)

**The report says:** PyMuPDF draws highlight annotations onto the PDF on the server
(`pdf_highlight.py`, `/highlight-pdf`).

**The code does:** the browser renders the resume with PDF.js and draws the highlights
itself, so moving between suggestions is only a scroll. The server-side highlighter and
its endpoints are gone, and JSON request bodies are capped at 2 MB, down from 50 MB.

## Progress while analysing (§7.4.1)

**The report says:** analysis status is polled while a job runs.

**The code does:** progress streams from the engine over server-sent events, one real
event per stage, with polling kept only for browsers that can't read a streamed
response. Suggestions appear batch by batch while the rest are still being written.

## Front end (§0.7, §5, §8, §9)

- **Recharts:** the report lists it for charts. There is no chart library. Score history
  is a list and section strength is a heatmap table. The chart packages were installed
  but never imported, and have been removed.
- **Routing:** the report describes client-side routing. The app now has real routes:
  `/`, `/history`, and `/attempts/:id/:tab` for the five tabs (Review, Job Fit,
  Documents, Progress, Mentor). A refresh reopens the same attempt on the same tab.
- **Other changes:** the resume uploads and parses as soon as it's picked. There's a
  landing page with a sample resume to try, one header with the only sign-out, dark
  mode, and keyboard and screen-reader fixes.

## Authentication and security (§7.5, §10, §14)

**The report says:** stateless JWT authentication. The client kept the token in
localStorage, and the Content-Security-Policy was switched off.

**The code does:**

- **Session:** the JWT travels in an httpOnly, SameSite=Strict cookie scoped to `/api`,
  which no script on the page can read. `/auth/me` tells the client who is signed in,
  and `/auth/logout` ends the session.
- **CSP:** switched on. It allows only the app's own scripts, Google Fonts and the
  PDF.js worker.
- **Accounts:** users can delete their account and everything in it, and expired guest
  accounts are swept on a timer.
- **Mentors:** a mentor loses access to a candidate when their review session is closed.

## Deployment (§0.7 plan, §10)

- **Streamlit:** the report's plan lists Streamlit Cloud or Vercel with Railway, and the
  acknowledgements list Streamlit. The Streamlit prototype has been removed from the
  repository.
- **Docker:** deployment is Docker Compose, with an optional Caddy overlay for HTTPS.
  The embedding model is built into the engine image and loaded at start-up, and
  Gunicorn no longer recycles the only worker every couple of hours.

## Testing (§13)

The report describes scenario-based evaluation and the critic benchmark. There are now
also automated suites, which CI runs on every push:

| Suite | Tests |
|---|---|
| Engine: parser, scoring, claim checks, keyword weaving, routing, analysis flow (`pytest`) | 359 |
| API (`node --test`, against a stub engine and an in-memory database) | 50 |
| Client: review, PDF text search, routes, keywords (`node --test`) | 33 |

The deterministic claim checks are also measured against labelled sets
(`eval_claims.py`):

| Set | Cases | Fabrication F1 |
|---|---|---|
| Development | 50 | 1.00 |
| Held out | 20 | 0.75 |

CI fails if the development set drops below 0.95 precision or recall. An offline replay
provider (`replay.py`, `demo/replay.json`) runs the whole pipeline end to end without a
key. Its answers are scripted, not recorded from a model: they deliberately include an
inflated role, an invented figure and an unsupported keyword, so the demo shows each
check catching one.
