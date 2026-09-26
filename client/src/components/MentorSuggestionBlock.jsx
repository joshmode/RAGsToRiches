import { CheckCircle2, XCircle } from "lucide-react"
import { InlineDiff } from "./DocumentDiff"

// true while the mentor's version is live. dismissing hands it back to the ai one
export function editSupersedes(feedback) {
    return !!feedback && feedback.status !== "dismissed"
}

// the ai suggestion is never throown away just struck through while the mentor's is live
export function MentorSuggestionBlock({ baseText, feedback, viewerRole }) {
    if (!feedback) return null
    const dismissed = feedback.status === "dismissed"
    return <div className={`mentor-suggestion-block ${dismissed ? "is-dismissed" : ""}`}>
        <span className="pane-label">
            {viewerRole === "mentor" ? "Your Suggestion" : "Mentor's Suggestion"}
            {feedback.status === "accepted" && <span className="decision-flag accepted"><CheckCircle2 size={12} /> Accepted</span>}
            {dismissed && <span className="decision-flag dismissed"><XCircle size={12} /> Dismissed</span>}
        </span>
        <InlineDiff before={baseText} after={feedback.suggested_text} side="after" />
        {feedback.comment && <p className="feedback-comment">{feedback.comment}</p>}
        {dismissed && <p className="feedback-superseded-note">
            Dismissed &mdash; the suggestion above is the active recommendation again. Kept here as part of the review history.
        </p>}
    </div>
}
