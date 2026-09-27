import { useEffect, useState } from "react"
import api from "../../api/client"
import { getError } from "../../lib/errors"

export function FeedbackComposer({ candidateId, analysisId, prefill, onSent }) {
    const [type, setType] = useState(prefill?.type || "comment")
    const [section, setSection] = useState(prefill?.section || "")
    const [originalText, setOriginalText] = useState(prefill?.original || "")
    const [suggestedText, setSuggestedText] = useState("")
    const [comment, setComment] = useState("")
    const [status, setStatus] = useState("")

    // the composer stays mounted and just swaps prefill
    useEffect(() => {
        if (prefill) {
            setType(prefill.type || "comment")
            setSection(prefill.section || "")
            setOriginalText(prefill.original || "")
            // prefilled when revising a dismissed one
            setSuggestedText(prefill.suggested || "")
            setComment("")
            setStatus("")
        }
        // sync all changes
    }, [prefill?.key, prefill?.seed])

    async function send() {
        setStatus("")
        try {
            await api.post("/mentor/feedback", {
                candidate_id: candidateId,
                analysis_id: analysisId || null,
                suggestion_key: prefill?.key || "",
                feedback_type: type,
                section,
                original_text: originalText,
                suggested_text: suggestedText,
                comment,
            })
            setStatus("Sent.")
            setSuggestedText("")
            setComment("")
            onSent?.(suggestedText)
        } catch (err) {
            setStatus(getError(err))
        }
    }

    const isEditLike = type === "edit" || type === "section_edit"
    return <div className="card composer">
        <span className="section-label">Send Feedback to Candidate</span>
        <div className="composer-row">
            <select className="input-field composer-type" value={type} onChange={e => setType(e.target.value)}>
                <option value="comment">Comment</option>
                <option value="edit">Bullet Edit</option>
                <option value="section_edit">Section Edit</option>
            </select>
            <input className="input-field" aria-label="Section" value={section} onChange={e => setSection(e.target.value)} placeholder="Section (e.g. EXPERIENCE, optional)" />
        </div>
        {isEditLike && <>
            <textarea className="input-field composer-area" aria-label="Original text" value={originalText} onChange={e => setOriginalText(e.target.value)} placeholder={type === "section_edit" ? "Original text of the whole section" : "Original text this edit applies to"} />
            <textarea className="input-field composer-area" aria-label="Suggested text" value={suggestedText} onChange={e => setSuggestedText(e.target.value)} placeholder={type === "section_edit" ? "Your rewritten version of the whole section" : "Your suggested replacement text"} />
        </>}
        <textarea className="input-field composer-area" aria-label="Comment" value={comment} onChange={e => setComment(e.target.value)} placeholder={isEditLike ? "Why this edit helps (optional)" : "Your feedback"} />
        <div className="composer-actions">
            <button className="btn-primary" onClick={send}>Send Feedback</button>
            {status && <span className="muted">{status}</span>}
        </div>
    </div>
}
