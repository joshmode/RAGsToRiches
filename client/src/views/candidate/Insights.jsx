import { useEffect, useState } from "react"
import api from "../../api/client"
import { getError } from "../../lib/errors"
import { heatmapQuality, isGraded } from "../../lib/score"
import { formatDateTime, formatDuration } from "../../lib/format"

const SECTION_ORDER = [
    "EXPERIENCE", "PROJECTS", "EDUCATION", "SKILLS", "SUMMARY", "CERTIFICATIONS",
    "AWARDS", "PUBLICATIONS", "VOLUNTEER", "LANGUAGES", "INTERESTS", "REFERENCES",
]

export function Insights({ result, history, decisions }) {
    const timing = result.timing || {}
    const [consent, setConsent] = useState(false)
    const [confidence, setConfidence] = useState("")
    const [comment, setComment] = useState("")
    const [submitted, setSubmitted] = useState(false)
    const [error, setError] = useState("")
    const [overview, setOverview] = useState(null)

    useEffect(() => {
        api.get("/analysis/insights/overview").then(res => setOverview(res.data.analyses || [])).catch(() => setOverview([]))
    }, [])

    async function submitFeedback() {
        setError("")
        try {
            await api.post("/feedback", { analysis_id: result.analysis_id, consent, confidence, comment })
            setSubmitted(true)
        } catch (err) {
            setError(getError(err))
        }
    }

    const sectionCols = overview ? (() => {
        const present = new Set(overview.flatMap(a => Object.keys(a.score?.section_scores || {})))
        return [...SECTION_ORDER.filter(s => present.has(s)), ...[...present].filter(s => !SECTION_ORDER.includes(s)).sort()]
    })() : []

    const jdKeywords = result.jd_keywords || []
    const missingKeywords = result.missing_keywords || []
    const atsMatch = jdKeywords.length ? Math.round(((jdKeywords.length - missingKeywords.length) / jdKeywords.length) * 100) : null

    const gradedSections = Object.entries(result.score?.section_scores || {}).filter(([, d]) => isGraded(d))
    let strongest = null, weakest = null
    for (const [sec, d] of gradedSections) {
        if (!strongest || d.quality > strongest.quality) strongest = { sec, quality: d.quality }
        if (!weakest || d.quality < weakest.quality) weakest = { sec, quality: d.quality }
    }

    let mostImproved = null
    if (overview && overview.length >= 2) {
        const latest = overview[overview.length - 1]
        const prior = overview[overview.length - 2]
        for (const [sec, d] of Object.entries(latest.score?.section_scores || {})) {
            const priorCell = prior.score?.section_scores?.[sec]
            if (!isGraded(d) || !isGraded(priorCell)) continue
            const priorQ = priorCell.quality
            const delta = d.quality - priorQ
            if (delta > 0 && (!mostImproved || delta > mostImproved.delta)) mostImproved = { sec, delta }
        }
    }

    const decisionValues = Object.values(decisions || {})
    const acceptedCount = decisionValues.filter(v => v === true).length
    const dismissedCount = decisionValues.filter(v => v === false).length
    const titleCase = s => s[0] + s.slice(1).toLowerCase()

    return <section>
        <h2 className="view-title">Insights</h2>

        <div className="metric-grid">
            <div className="stat-card">
                <span className="stat-label">ATS Match</span>
                <span className="stat-value">{atsMatch !== null ? `${atsMatch}%` : "—"}</span>
                <span className="stat-caption">{atsMatch !== null ? `${jdKeywords.length - missingKeywords.length} of ${jdKeywords.length} JD keywords present` : "No job description provided"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Keyword Coverage</span>
                <span className="stat-value">{atsMatch !== null ? `${atsMatch}%` : "—"}</span>
                <span className="stat-caption">{atsMatch === null ? "Add a job description to see this" : missingKeywords.length ? `${missingKeywords.length} keywords missing` : "All keywords covered"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Strongest Section</span>
                <span className="stat-value stat-value-text">{strongest ? titleCase(strongest.sec) : "—"}</span>
                <span className="stat-caption">{strongest ? `${strongest.quality}% quality` : "Not enough data yet"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Weakest Section</span>
                <span className="stat-value stat-value-text">{weakest ? titleCase(weakest.sec) : "—"}</span>
                <span className="stat-caption">{weakest ? `${weakest.quality}% quality` : "Not enough data yet"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Most Improved Section</span>
                <span className="stat-value stat-value-text">{mostImproved ? titleCase(mostImproved.sec) : "—"}</span>
                <span className="stat-caption">{mostImproved ? `+${mostImproved.delta}% since last attempt` : "Run a second analysis to compare"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Suggestions Reviewed</span>
                <span className="stat-value"><span className="stat-accept">{acceptedCount}</span> / <span className="stat-dismiss">{dismissedCount}</span></span>
                <span className="stat-caption">accepted / dismissed</span>
            </div>
        </div>

        <h3 className="doc-subhead">Resume Score History</h3>
        <div className="card history-list">{history.length ? history.map((item, index) => <div key={item.id || index}><b>Attempt {history.length - index}</b><span className="tabular-num">{item.attempt_type === "cover_letter_only" ? "Cover Letter" : `${item.score}/100`}</span><small>{formatDateTime(item.created_at)}</small></div>) : <p className="muted">Run more analyses to see score progression.</p>}</div>

        <h3 className="doc-subhead">Readability &amp; Quality Heatmap</h3>
        <p className="muted">How strong each section's writing has been across your attempts. Each row is one attempt, oldest first.</p>
        {overview && overview.length > 0 && sectionCols.length > 0 ? <div className="heatmap-table-wrap"><table className="heatmap-table"><thead><tr><th>Attempt</th>{sectionCols.map(sec => <th key={sec}>{titleCase(sec)}</th>)}</tr></thead><tbody>{overview.map((a, idx) => <tr key={a.id}><td className="heatmap-row-label"><b>#{idx + 1}</b><small>{String(a.created_at || "").slice(0, 10)}</small></td>{sectionCols.map(sec => {
            const cell = a.score?.section_scores?.[sec]
            if (!isGraded(cell)) return <td key={sec}><div className="heatmap-square empty" title={cell ? "Not graded: no bullets the rubric applies to" : undefined}>—</div></td>
            const hq = heatmapQuality(cell.quality)
            return <td key={sec}><div className="heatmap-square" style={{ background: hq.color }} title={`${hq.label} — ${cell.quality}%`}>
                <span className="heatmap-square-pct">{cell.quality}%</span>
                <span className="heatmap-square-label">{hq.label}</span>
            </div></td>
        })}</tr>)}</tbody></table></div> : <p className="muted">{overview ? "Run more analyses to build up the heatmap." : "Loading…"}</p>}

        <details className="card technical-details">
            <summary>Technical Details</summary>
            <div className="three-col tech-metric-grid">{Object.entries(timing).map(([key, value]) => <div className="tech-metric" key={key}><div className="tech-metric-value">{formatDuration(value)}</div><div className="metric-label">{key.replace("_ms", "").replace("_", " ")}</div></div>)}</div>
        </details>

        <div className="card evaluation-card"><span className="section-label">Optional Evaluation</span><p className="muted">Share anonymised confidence feedback without including your resume content.</p>{submitted ? <p className="success-msg">Thanks for your feedback.</p> : <><label className="toggle-wrap"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I consent to store this evaluation response.</label><label className="form-group">Confidence in these recommendations<span className="confidence-scale-hint">1 = Worst · 5 = Best</span><select className="input-field" value={confidence} onChange={e => setConfidence(e.target.value)}><option value="">Select a rating</option>{[1, 2, 3, 4, 5].map(value => <option value={value} key={value}>{value}</option>)}</select></label><textarea className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional qualitative feedback" />{error && <p className="error-msg">{error}</p>}<button className="btn-secondary btn-block-gap" disabled={!consent} onClick={submitFeedback}>Submit Feedback</button></>}</div>
    </section>
}
