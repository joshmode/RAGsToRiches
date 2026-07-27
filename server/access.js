import { getDb } from "./db.js"

export function getResume(resumeId, userId) {
    return getDb().prepare("SELECT * FROM resumes WHERE id = ? AND user_id = ?").get(resumeId, userId)
}

export function getAnalysis(analysisId, userId) {
    return getDb().prepare("SELECT * FROM analyses WHERE id = ? AND user_id = ?").get(analysisId, userId)
}

export function canAccess(analysisId, user) {
    const owned = getAnalysis(analysisId, user.id)
    if (owned) return owned
    if (user.role !== "mentor") return null

    return getDb().prepare(`
        SELECT a.*
        FROM analyses a
        JOIN resumes r ON r.id = a.resume_id
        JOIN session_participants sp ON sp.user_id = a.user_id
        JOIN review_sessions rs ON rs.id = sp.session_id
        WHERE a.id = ? AND rs.mentor_id = ? AND rs.active = 1
        LIMIT 1
    `).get(analysisId, user.id)
}

// trust is session membership, only your own candidates
export function mentorSession(mentorId, candidateId, { activeOnly = true } = {}) {
    return getDb().prepare(`
        SELECT rs.id, rs.session_code, rs.active
        FROM review_sessions rs
        JOIN session_participants sp ON sp.session_id = rs.id
        WHERE rs.mentor_id = ? AND sp.user_id = ? ${activeOnly ? "AND rs.active = 1" : ""}
        ORDER BY rs.active DESC, rs.created_at DESC
        LIMIT 1
    `).get(mentorId, candidateId)
}

// a candidate can sit in more than one mentor's session
export function mentorsFor(candidateId) {
    return getDb().prepare(`
        SELECT DISTINCT rs.mentor_id
        FROM review_sessions rs
        JOIN session_participants sp ON sp.session_id = rs.id
        WHERE sp.user_id = ? AND rs.active = 1
    `).all(candidateId).map(r => r.mentor_id)
}
