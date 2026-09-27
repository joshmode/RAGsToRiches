import { useEffect, useState } from "react"
import api from "../api/client"
import { getError } from "../lib/errors"
import { formatDateTime } from "../lib/format"

// one flat thread per suggestion
export function AnnotationThread({ analysisId, suggestionKey, section, viewerRole = "candidate" }) {
    const [annotations, setAnnotations] = useState([])
    const [comment, setComment] = useState("")
    const [error, setError] = useState("")

    async function load() {
        if (!analysisId || !suggestionKey) { setAnnotations([]); return }
        try {
            const res = await api.get(`/annotations/${analysisId}`)
            setAnnotations(res.data.filter(item => item.key === suggestionKey))
        } catch { setAnnotations([]) }
    }
    useEffect(() => { load() }, [analysisId, suggestionKey])

    async function postComment() {
        if (!comment.trim() || !analysisId || !suggestionKey) return
        setError("")
        try {
            await api.post("/annotations", { analysis_id: analysisId, suggestion_key: suggestionKey, comment, section: section || "" })
            setComment("")
            await load()
        } catch (err) { setError(`Couldn't post comment: ${getError(err)}`) }
    }

    return <div className="annotation-thread">
        <span className="section-label">Discussion</span>
        {error && <p className="warning-strip">{error}</p>}
        {annotations.length === 0 && <p className="muted annotation-empty">No comments yet - {viewerRole === "mentor" ? "leave a note or ask the candidate a question about this suggestion." : "ask your mentor a question or leave a note about this suggestion."}</p>}
        {annotations.map(annotation => (
            <div className="annotation-card" key={annotation.id}>
                <span className={`ann-user ${annotation.role === "mentor" ? "ann-user-mentor" : ""}`}>{annotation.role === viewerRole ? "You" : annotation.role === "mentor" ? `${annotation.user} (Mentor)` : annotation.user}</span>
                <span className="ann-time">{formatDateTime(annotation.time)}</span>
                <div className="ann-body">{annotation.comment}</div>
            </div>
        ))}
        <div className="annotation-input">
            <input className="input-field" aria-label="Add a comment" value={comment} onChange={e => setComment(e.target.value)} placeholder={viewerRole === "mentor" ? "Reply or leave a note for the candidate" : "Ask a question or leave a comment for your mentor"} />
            <button className="btn-secondary" onClick={postComment}>Post Comment</button>
        </div>
    </div>
}
