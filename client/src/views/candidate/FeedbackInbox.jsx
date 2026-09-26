import { useEffect, useState } from "react"
import { Check, CheckCircle2, X, XCircle } from "lucide-react"
import api from "../../api/client"
import { getError } from "../../lib/errors"
import { capitalize, formatShortDate, parseTs } from "../../lib/format"
import { NotificationBadge } from "../../components/NotificationBadge"
import { DocumentDiff } from "../../components/DocumentDiff"
import { AnnotationThread } from "../../components/AnnotationThread"

// exact match on the open attempt
export function FeedbackInbox({ analysisId, attemptType, unreadByType = {}, onDocumentAccepted }) {
    const [items, setItems] = useState(null)
    const [error, setError] = useState("")
    // stops a double-click firing two requests before the re-fetch lands
    const [busyId, setBusyId] = useState(null)
    // follows the open attempt 
    const [tab, setTab] = useState(attemptType === "cover_letter_only" ? "cover_letter" : "resume")
    useEffect(() => {
        if (attemptType) setTab(attemptType === "cover_letter_only" ? "cover_letter" : "resume")
    }, [analysisId, attemptType])

    async function load() {
        try { setItems((await api.get("/mentor/feedback/inbox")).data) } catch (err) { setError(getError(err)) }
    }
    useEffect(() => { load() }, [])

    async function setStatus(id, status) {
        if (busyId) return
        setBusyId(id)
        try {
            const res = await api.post(`/mentor/feedback/${id}/status`, { status })
            await load()
            // effective server-side already (see documents.js), so update the open editor
            if (res.data.document_type && res.data.content !== undefined) {
                onDocumentAccepted?.(res.data.document_type, res.data.content)
            }
        } catch (err) { setError(getError(err)) } finally { setBusyId(null) }
    }

    if (error) return <p className="warning-strip">{error}</p>
    if (!items) return <p className="muted">Loading feedback...</p>
    if (!items.length) return <div className="card muted">No mentor feedback yet. Join a review session from the sidebar, and your mentor's comments and suggested edits will appear here.</div>

    const activeAttempt = analysisId || items.reduce((max, f) => (f.attempt_number || 0) > (max?.attempt_number || 0) ? f : max, null)?.analysis_id
    const workflowOf = f => f.attempt_type === "cover_letter_only" ? "cover_letter" : "resume"
    const current = items.filter(f => f.status !== "dismissed" && f.analysis_id === activeAttempt && workflowOf(f) === tab)
    const previous = items
        .filter(f => (f.status === "dismissed" || f.analysis_id !== activeAttempt) && workflowOf(f) === tab)
        .sort((a, b) => parseTs(a.created_at) - parseTs(b.created_at))

    // an accepted section edit supersedes that section's bullets
    const supersededSections = new Set(
        items.filter(f => f.analysis_id === activeAttempt && f.feedback_type === "section_edit" && f.status === "accepted").map(f => f.section)
    )

    const FEEDBACK_TYPE_LABEL = { comment: "Comment", edit: "Bullet Edit", section_edit: "Section Edit" }

    function renderItem(f) {
        // superseded by a section edit kept for context only
        const superseded = f.feedback_type === "edit" && f.section && supersededSections.has(f.section)
        return <div className={`card feedback-item ${f.status} ${f.feedback_type === "section_edit" ? "feedback-item-section-edit" : ""} ${superseded ? "feedback-item-superseded" : ""}`} key={f.id}>
            <div className="feedback-meta">
                <b>{f.mentor_name}</b>
                <span className={`fw-badge ${f.feedback_type === "section_edit" ? "fw-badge-section-edit" : ""}`}>{f.feedback_type === "edit" && f.section === "Cover Letter" ? "Suggested Edit" : (FEEDBACK_TYPE_LABEL[f.feedback_type] || capitalize(f.feedback_type))}</span>
                {f.section && <span className="status-chip">{f.section}</span>}
                {f.status === "accepted" ? <span className="decision-flag accepted"><CheckCircle2 size={12} /> Accepted</span>
                    : f.status === "dismissed" ? <span className="decision-flag dismissed"><XCircle size={12} /> Dismissed</span>
                    : <span className={`status-chip status-${f.status}`}>{capitalize(f.status)}</span>}
                {f.attempt_number && <span className="feedback-attempt-meta">Attempt #{f.attempt_number} &bull; {formatShortDate(f.created_at)}</span>}
            </div>
            {/* the original stays struck through while the mentor's rewrite is the live
                proposal, and is restored the moment the rewrite is dismissed */}
            {(f.feedback_type === "edit" || f.feedback_type === "section_edit") && <DocumentDiff
                before={f.original_text} after={f.suggested_text}
                labelBefore={f.feedback_type === "section_edit" ? "Original section" : "Original"}
                labelAfter="Mentor's rewrite"
                className={f.status === "dismissed" ? "" : "original-superseded"}
            />}
            {f.comment && <p className="feedback-comment">{f.comment}</p>}
            {f.suggestion_key && f.suggestion_key.startsWith("cover_letter:") && <AnnotationThread analysisId={f.analysis_id} suggestionKey={`cover_letter_feedback:${f.id}`} section="Cover Letter" viewerRole="candidate" />}
            {superseded ? (
                <p className="feedback-superseded-note">Section was replaced by mentor rewrite. Please view the Tailored CV preview.</p>
            ) : f.status === "open" && <div className="composer-actions">
                <button className="btn-primary" disabled={busyId === f.id} onClick={() => setStatus(f.id, "accepted")}><Check size={15} /> Accept</button>
                <button className="btn-ghost" disabled={busyId === f.id} onClick={() => setStatus(f.id, "dismissed")}><X size={14} /> Dismiss</button>
            </div>}
        </div>
    }

    return <section>
        <h2 className="view-title">Mentor Feedback</h2>
        <div className="history-type-toggle">
            <button className={tab === "resume" ? "active" : ""} onClick={() => setTab("resume")}>Resume Analysis<NotificationBadge count={unreadByType.resume_analysis} /></button>
            <button className={tab === "cover_letter" ? "active" : ""} onClick={() => setTab("cover_letter")}>Cover Letters<NotificationBadge count={unreadByType.cover_letter_only} /></button>
        </div>
        <div className="feedback-list">
            {current.length ? current.map(renderItem) : <p className="muted">No feedback yet for your current attempt.</p>}
        </div>
        {previous.length > 0 && <details className="card previous-feedback">
            <summary>Previous Feedback ({previous.length})</summary>
            <div className="feedback-list">{previous.map(renderItem)}</div>
        </details>}
    </section>
}
