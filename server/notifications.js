import { getDb } from "./db.js"

// one unread row per recipient, analysisId nullable like mentor_feedback's
export function notify(userId, { analysisId = null, attemptType = "resume_analysis", eventType }) {
    getDb().prepare(
        "INSERT INTO notifications (user_id, analysis_id, attempt_type, event_type, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(userId, analysisId, attemptType, eventType)
}

export function notifyMany(userIds, opts) {
    for (const userId of userIds) notify(userId, opts)
}
