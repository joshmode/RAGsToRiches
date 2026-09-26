import { useEffect, useMemo, useState } from "react"
import { CheckCircle2, RotateCw, XCircle } from "lucide-react"
import api from "../api/client"
import { getError } from "../lib/errors"
import { formatDateTime, parseTs } from "../lib/format"
import { DocumentDiff } from "./DocumentDiff"

// everything merged into one ordered list 
export function RevisionTimeline({ analysisId, documentType, viewerRole = "candidate", refreshKey = 0, onReuse }) {
    const [data, setData] = useState(null)
    const [error, setError] = useState("")

    useEffect(() => {
        if (!analysisId) { setData(null); return undefined }
        let cancelled = false
        setError("")
        api.get(`/generate/timeline?analysis_id=${analysisId}&document_type=${documentType}`)
            .then(res => { if (!cancelled) setData(res.data) })
            .catch(err => { if (!cancelled) setError(getError(err)) })
        return () => { cancelled = true }
    }, [analysisId, documentType, refreshKey])

    const entries = useMemo(() => {
        if (!data) return []
        const out = []
        // every generation a jd refresh makes another and dropping it leaves a hole
        ;(data.versions || []).filter(v => v.source === "ai").forEach((v, i) => {
            out.push({
                key: `ai-${v.id}`, at: v.created_at, kind: "ai",
                title: i === 0 ? "AI Generated" : "AI Regenerated", body: v.content,
            })
        })
        for (const v of (data.versions || []).filter(v => v.source === "user")) {
            out.push({
                // one sitting of autosaves is one version, shown at its last save
                key: `user-${v.id}`, at: v.updated_at || v.created_at, kind: "user",
                title: viewerRole === "candidate" ? "Your edit" : `${v.author_name || "Candidate"}'s edit`, body: v.content,
            })
        }
        // in the order sent each followed by its decision
        ;(data.feedback || []).forEach((f, i) => {
            out.push({
                key: `mf-${f.id}`, at: f.created_at, kind: "mentor", feedback: f,
                title: `Mentor Revision #${i + 1}`, author: f.mentor_name,
                before: f.original_text, after: f.suggested_text, comment: f.comment,
            })
            if (f.status !== "open") {
                out.push({
                    key: `dec-${f.id}`, at: f.updated_at, kind: "decision", status: f.status,
                    title: `User Decision · Revision #${i + 1}`, feedback: f,
                })
            }
        })
        for (const d of (data.discussion || [])) {
            out.push({ key: `an-${d.id}`, at: d.created_at, kind: "comment", title: d.author_name, authorRole: d.author_role, body: d.comment })
        }
        return out.sort((a, b) => parseTs(a.at) - parseTs(b.at))
    }, [data, viewerRole])

    if (error) return <p className="warning-strip">{error}</p>
    if (!data) return null
    if (!entries.length) return <p className="muted">No revisions recorded for this attempt yet.</p>

    return <ol className="revision-timeline">
        {entries.map(entry => <li className={`revision-entry revision-${entry.kind}`} key={entry.key}>
            <div className="revision-head">
                <span className="revision-title">{entry.title}</span>
                {entry.author && <span className="status-chip">{entry.author}</span>}
                {entry.kind === "decision" && (entry.status === "accepted"
                    ? <span className="decision-flag accepted"><CheckCircle2 size={12} /> Accepted</span>
                    : <span className="decision-flag dismissed"><XCircle size={12} /> Dismissed</span>)}
                <span className="revision-time">{formatDateTime(entry.at)}</span>
            </div>
            {entry.kind === "mentor" && <DocumentDiff
                before={entry.before} after={entry.after}
                labelBefore="Before" labelAfter="Mentor rewrite"
                className={entry.feedback.status === "dismissed" ? "" : "original-superseded"}
            />}
            {entry.comment && <p className="feedback-comment">{entry.comment}</p>}
            {entry.body && entry.kind !== "mentor" && <pre className="section-pre revision-body">{entry.body}</pre>}
            {/* a dismissed revision is where the next one starts */}
            {entry.kind === "decision" && entry.status === "dismissed" && viewerRole === "mentor" && onReuse &&
                <button className="pill suggest-edit-pill" onClick={() => onReuse(entry.feedback)}>
                    <RotateCw size={12} /> Reuse &amp; revise this suggestion
                </button>}
        </li>)}
    </ol>
}
