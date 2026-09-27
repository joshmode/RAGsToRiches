import { Suspense, lazy, useEffect, useMemo, useState } from "react"
import { Building2, Check, CheckCircle2, RotateCw, XCircle } from "lucide-react"
import api from "../../api/client"
import { getError } from "../../lib/errors"
import { numberClAtts } from "../../lib/attempts"
import { capitalize, formatDateTime, formatShortDate, parseTs } from "../../lib/format"
import { toast } from "../../components/Toast"
import { DocumentDiff } from "../../components/DocumentDiff"
import { AnnotationThread } from "../../components/AnnotationThread"
import { RevisionTimeline } from "../../components/RevisionTimeline"

const PdfViewer = lazy(() => import("../../components/PdfViewer"))

// its own component, almost nothing is shared with the resume workspace
export function CoverLetterWorkspace({ candidate, attempts, sent, onSent, unreadById = {} }) {
    const [openId, setOpenId] = useState(null)
    const [content, setContent] = useState("")
    const [baseline, setBaseline] = useState("")
    const [comment, setComment] = useState("")
    const [resumePdf, setResumePdf] = useState(null)
    const [diffFrom, setDiffFrom] = useState("")
    const [diffTo, setDiffTo] = useState("")
    const [diff, setDiff] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [historyOpen, setHistoryOpen] = useState(true)
    const [refreshKey, setRefreshKey] = useState(0)

    const clNumberOf = useMemo(() => numberClAtts(attempts), [attempts])
    const open = attempts.find(a => a.id === openId)
    const sameCo = open
        ? attempts.filter(a => (a.company || "").trim().toLowerCase() === (open.company || "").trim().toLowerCase())
        : []

    // feedback from previous attempts at the same company only
    const previousCompanyAttemptIds = open
        ? sameCo.filter(a => a.id !== openId).map(a => a.id)
        : []
    const currentFeedback = sent.filter(f => f.analysis_id === openId && f.suggestion_key && f.suggestion_key.startsWith("cover_letter:"))
    const previousFeedback = sent
        .filter(f => previousCompanyAttemptIds.includes(f.analysis_id) && f.suggestion_key && f.suggestion_key.startsWith("cover_letter:"))
        .sort((a, b) => parseTs(a.created_at) - parseTs(b.created_at))

    async function openAttempt(id) {
        setDiff(null)
        setDiffFrom(""); setDiffTo("")
        setOpenId(id)
        setHistoryOpen(false)
        setError("")
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/analyses/${id}/cover-letter`)
            const savedContent = res.data.content || ""
            // resume from their own draft if there is one
            const mine = sent
                .filter(f => f.analysis_id === id && f.suggestion_key === `cover_letter:${id}`)
                .sort((a, b) => parseTs(b.updated_at || b.created_at) - parseTs(a.updated_at || a.created_at))[0]
            setBaseline(savedContent)
            setContent(mine ? mine.suggested_text : savedContent)
            setComment("")
            api.post("/notifications/mark-read", { analysis_id: id }).catch(() => {})
        } catch (err) { setError(getError(err)) }
    }

    // plain and unhighlighted unlike the analysis workspace
    useEffect(() => {
        if (!open) { setResumePdf(null); return undefined }
        let cancelled = false
        api.get(`/mentor/candidates/${candidate.id}/resumes/${open.resume_id}/file`, { responseType: "blob" })
            .then(res => { if (!cancelled) setResumePdf(res.data) })
            .catch(() => { if (!cancelled) setResumePdf(null) })
        return () => { cancelled = true }
    }, [open?.resume_id, candidate.id])

    async function submit() {
        if (!content.trim() || !open) return
        setBusy(true)
        setError("")
        try {
            await api.post("/mentor/feedback", {
                candidate_id: candidate.id,
                analysis_id: open.id,
                suggestion_key: `cover_letter:${open.id}`,
                feedback_type: "edit",
                section: "Cover Letter",
                original_text: baseline,
                suggested_text: content,
                comment,
            })
            setBaseline(content)
            setComment("")
            setRefreshKey(k => k + 1)
            toast("Cover letter feedback sent to candidate")
            onSent()
        } catch (err) { setError(getError(err)) } finally { setBusy(false) }
    }

    // a dismissed rewrite is where the next one starts
    function reuseSuggestion(f) {
        setContent(f.suggested_text || "")
        setComment("")
        toast("Previous suggestion loaded — amend it and submit again")
    }

    async function runDiff() {
        if (!diffFrom || !diffTo) return
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/cover-letter-diff?from=${diffFrom}&to=${diffTo}`)
            setDiff(res.data)
        } catch (err) { setError(getError(err)) }
    }

    function renderFeedbackItem(f) {
        return <div className={`card feedback-item ${f.status}`} key={f.id}>
            <div className="feedback-meta">
                <span className="fw-badge">Suggested Edit</span>
                {f.section && <span className="status-chip">{f.section}</span>}
                {f.status === "accepted" ? <span className="decision-flag accepted"><CheckCircle2 size={12} /> Accepted</span>
                    : f.status === "dismissed" ? <span className="decision-flag dismissed"><XCircle size={12} /> Dismissed</span>
                    : <span className={`status-chip status-${f.status}`}>{capitalize(f.status)}</span>}
                <span className="feedback-attempt-meta">{formatShortDate(f.created_at)}</span>
            </div>
            {f.feedback_type === "edit" && <DocumentDiff
                before={f.original_text} after={f.suggested_text}
                labelBefore="Original cover letter" labelAfter="Your rewrite"
                className={f.status === "dismissed" ? "" : "original-superseded"}
            />}
            {f.comment && <p className="feedback-comment">{f.comment}</p>}
            {f.status === "dismissed" && <button className="pill suggest-edit-pill" onClick={() => reuseSuggestion(f)}>
                <RotateCw size={12} /> Reuse &amp; revise this suggestion
            </button>}
            <AnnotationThread analysisId={f.analysis_id} suggestionKey={`cover_letter_feedback:${f.id}`} section="Cover Letter" viewerRole="mentor" />
        </div>
    }

    return <div className="cl-workspace-grid">
        <div className="cl-workspace-left">
            <details className="card mentor-history-card" open={historyOpen} onToggle={e => setHistoryOpen(e.currentTarget.open)}>
                <summary>Cover Letter History</summary>
                <div className="mentor-history-table-wrap"><table><thead><tr><th>Company</th><th>Attempt</th><th>Job Fit</th><th>Date</th><th /></tr></thead><tbody>
                    {attempts.map(a => <tr key={a.id} className={`${openId === a.id ? "mentor-history-row-open" : ""} ${unreadById[a.id] ? "history-row-unread-mentor" : ""}`}>
                        <td><Building2 size={12} /> {a.company || "Company not detected"}</td>
                        <td>#{clNumberOf[a.id]}</td>
                        <td>{a.match_pct != null ? `${a.match_pct}%` : "—"}</td>
                        <td>{formatDateTime(a.created_at)}</td>
                        <td><button className="btn-secondary btn-small" onClick={() => openAttempt(a.id)}>Open</button></td>
                    </tr>)}
                    {!attempts.length && <tr><td colSpan={5} className="muted">No cover letters yet.</td></tr>}
                </tbody></table></div>
            </details>
            {error && <p className="warning-strip">{error}</p>}
            {!diff && open && <>
                <span className="section-label">Cover Letter Preview</span>
                <textarea className="input-field doc-editor mentor-preview-editor" value={content} onChange={e => setContent(e.target.value)} />
                <div className="mentor-preview-actions cover-letter-submit-row">
                    <textarea className="input-field cover-letter-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional comment for the candidate" />
                    <button className="btn-primary" disabled={busy || !content.trim()} onClick={submit}><Check size={15} /> Submit</button>
                </div>
            </>}
            {!diff && !open && <div className="card muted">Open a cover letter attempt to review it.</div>}
            <span className="section-label">Compare Revisions</span>
            <p className="muted">Only attempts for the same company as the one you have open can be compared.</p>
            <div className="card">
                <div className="composer-row">
                    <select className="input-field" value={diffFrom} onChange={e => setDiffFrom(e.target.value)} disabled={!open}>
                        <option value="">Before…</option>
                        {sameCo.map(a => <option key={a.id} value={a.id}>#{clNumberOf[a.id]} · {formatDateTime(a.created_at)}</option>)}
                    </select>
                    <select className="input-field" value={diffTo} onChange={e => setDiffTo(e.target.value)} disabled={!open}>
                        <option value="">After…</option>
                        {sameCo.map(a => <option key={a.id} value={a.id}>#{clNumberOf[a.id]} · {formatDateTime(a.created_at)}</option>)}
                    </select>
                    <button className="btn-primary" onClick={runDiff} disabled={!diffFrom || !diffTo || diffFrom === diffTo}>Compare</button>
                </div>
            </div>
            {diff && <details className="card cl-diff-result" open>
                <summary>Cover Letter Diff · #{clNumberOf[diff.from.id]} ({diff.from.company || "company not detected"}) → #{clNumberOf[diff.to.id]}</summary>
                <DocumentDiff before={diff.before} after={diff.after} labelBefore="Earlier attempt" labelAfter="Later attempt" />
            </details>}
            {open && currentFeedback.length > 0 && <>
                <span className="section-label">Current Attempt Feedback</span>
                <div className="feedback-list">{currentFeedback.map(renderFeedbackItem)}</div>
            </>}
            {open && previousFeedback.length > 0 && <details className="card cl-previous-feedback">
                <summary>Previous Feedback — {open.company || "this company"} ({previousFeedback.length})</summary>
                <div className="feedback-list">{previousFeedback.map(renderFeedbackItem)}</div>
            </details>}
            {/* the whole trail for this attempt - the original letter, every mentor
                revision, each accept/dismiss decision, and the discussion around them */}
            {open && <details className="card cl-previous-feedback" open>
                <summary>Revision Timeline{open.company ? ` — ${open.company}` : ""}</summary>
                <RevisionTimeline
                    analysisId={open.id} documentType="cover_letter" viewerRole="mentor"
                    refreshKey={refreshKey} onReuse={reuseSuggestion}
                />
            </details>}
        </div>
        <div className="cl-workspace-right">
            {open && (resumePdf
                ? <div className="pdf-shell"><Suspense fallback={<p className="muted pdf-viewer-note">Loading the preview…</p>}><PdfViewer file={resumePdf} title="Candidate's original resume" /></Suspense></div>
                : <div className="card muted">Source preview is available for PDF uploads only.</div>)}
            {!open && <div className="card muted">Open a cover letter attempt to see the original resume.</div>}
        </div>
    </div>
}
