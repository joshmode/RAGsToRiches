import { CheckCircle2, XCircle } from "lucide-react"

// which of the job's keywords the resume mentions, and how often
export function KeywordGap({ result }) {
    const keywords = result.jd_keywords || []
    if (!keywords.length) return null
    const missing = result.missing_keywords || []
    const present = keywords.filter(item => !missing.includes(item))
    return <div className="two-col keyword-gap">
        <div>
            <span className="section-label"><XCircle size={13} aria-hidden="true" /> Missing ({missing.length})</span>
            <div className="kw-wrap">{missing.map(item => <span className="kw-missing" key={item}>{item}</span>)}</div>
        </div>
        <div>
            <span className="section-label"><CheckCircle2 size={13} aria-hidden="true" /> On your resume ({present.length})</span>
            <div className="kw-wrap">{present.map(item => <span className="kw-present" key={item}>{item} <small>×{result.keyword_frequencies?.[item] || 0}</small></span>)}</div>
        </div>
    </div>
}
