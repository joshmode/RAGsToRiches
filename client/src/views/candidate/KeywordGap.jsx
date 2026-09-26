import { CheckCircle2, XCircle } from "lucide-react"

export function KeywordGap({ result }) {
    const keywords = result.jd_keywords || []
    if (!keywords.length) {
        if (result.keyword_extraction_failed) return <><h2 className="view-title">Keyword Gap</h2><p className="warning-strip">Keyword extraction from the job description failed (the model may be rate-limited or temporarily unavailable). Re-run the analysis to try again.</p></>
        return <><h2 className="view-title">Keyword Gap</h2><p className="muted">Paste a job description above and re-analyse to see keyword gaps.</p></>
    }
    const missing = result.missing_keywords || []
    const present = keywords.filter(item => !missing.includes(item))
    const coverage = Math.round(present.length / keywords.length * 100)
    return <><h2 className="view-title">Keyword Gap</h2><div className="card"><span className="section-label">Coverage</span><p className="metric-value">{coverage}%</p><p className="muted">{present.length} of {keywords.length} JD keywords present in your resume</p></div><div className="two-col"><div><span className="section-label"><XCircle size={13} /> Missing ({missing.length})</span><div className="kw-wrap">{missing.map(item => <span className="kw-missing" key={item}>{item}</span>)}</div></div><div><span className="section-label"><CheckCircle2 size={13} /> Present ({present.length})</span><div className="kw-wrap">{present.map(item => <span className="kw-present" key={item}>{item} ({result.keyword_frequencies?.[item] || 0})</span>)}</div></div></div></>
}
