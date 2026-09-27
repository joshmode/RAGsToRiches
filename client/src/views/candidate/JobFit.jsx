import { Building2, CheckCircle2, Lightbulb } from "lucide-react"
import { keywordsGained } from "../../lib/keywords"
import { KeywordGap } from "./KeywordGap"
import { JobMatching } from "./JobMatching"

// one number for how the resume covers the job: the share of its keywords the
// resume mentions. the rewrites can only raise it with keywords the bullets back up
export function JobFit({ result, decisions, jobMatching }) {
    const keywords = result.jd_keywords || []
    const missing = result.missing_keywords || []
    const present = keywords.length - missing.length
    const pct = result.match_pct ?? (keywords.length ? Math.round(100 * present / keywords.length) : null)
    const gained = keywordsGained(result, decisions)
    const after = keywords.length ? Math.round(100 * (present + gained.length) / keywords.length) : null

    let body
    if (result.keyword_extraction_failed) {
        body = <p className="warning-strip">The job description couldn't be read this time (the model may be rate-limited). Analyse again to retry.</p>
    } else if (!keywords.length) {
        body = <div className="card muted">No job description was given for this attempt. Paste one on the start page and analyse again, or check a job ad by its link below.</div>
    } else {
        body = <>
            <div className="card job-fit-card">
                <div className="job-fit-number">
                    <span className="metric-value">{pct}%</span>
                    <span className="muted">{present} of the job's {keywords.length} keywords are on your resume</span>
                </div>
                {result.company && <p className="job-match-company"><Building2 size={13} aria-hidden="true" /> {result.company}</p>}
                {gained.length > 0 && <p className="job-fit-gain">
                    <CheckCircle2 size={14} aria-hidden="true" />
                    <span>Your accepted rewrites add {gained.join(", ")}, which takes it to {after}% once you upload the revised resume.</span>
                </p>}
                {(result.tailoring_tips || []).length > 0 && <ul className="job-fit-tips">
                    {result.tailoring_tips.map(tip => <li key={tip}><Lightbulb size={13} aria-hidden="true" /> <span>{tip}</span></li>)}
                </ul>}
            </div>
            <KeywordGap result={result} />
        </>
    }

    return <section>
        <h2 className="view-title">Job Fit</h2>
        {body}
        <JobMatching result={result} {...jobMatching} />
    </section>
}
