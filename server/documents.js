import { getDb } from "./db.js"

// append-only, every revision keeps its row. read through effective()

export const TYPES = new Set(["cv", "cover_letter"])

// whole-doc rewrites have no bullet to key off, so synthesise one
export function sugKey(type, analysisId) {
    return type === "cover_letter" ? `cover_letter:${analysisId}` : `preview:${analysisId}`
}

// caller's value, else whatever the analysis got off the jd, else the last one recorded
export function getCompany(analysisId, explicit = "") {
    const co = String(explicit || "").trim()
    if (co) return co.slice(0, 200)
    if (!analysisId) return ""
    const db = getDb()

    const row = db.prepare("SELECT results_json FROM analyses WHERE id = ?").get(analysisId)
    if (row) {
        try {
            const found = String(JSON.parse(row.results_json).company || "").trim()
            if (found) return found.slice(0, 200)
        } catch { /* bad results_json, fall through to history */ }
    }

    const prev = db.prepare(`
        SELECT company FROM generated_documents
        WHERE analysis_id = ? AND document_type = 'cover_letter' AND company != ''
        ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(analysisId)
    return prev ? String(prev.company || "").slice(0, 200) : ""
}

// append-only, no update/delete path on purpose
export function saveRev({
    analysisId, ownerId, type, content,
    source = "ai", authorId = null, mentorFeedbackId = null, comment = "", company = "",
}) {
    if (!analysisId || !ownerId || !TYPES.has(type)) return null
    // only a cover letter has a company
    const co = type === "cover_letter" ? getCompany(analysisId, company) : ""
    const row = getDb().prepare(`
        INSERT INTO generated_documents
            (analysis_id, user_id, document_type, content, company, source, author_id, mentor_feedback_id, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
        analysisId, ownerId, type, String(content ?? ""), co,
        source, authorId, mentorFeedbackId, String(comment || ""),
    )
    return row.lastInsertRowid
}

// latest whole-doc rewrite the candidate accepted
export function acceptedRewrite(analysisId, ownerId, type) {
    if (!analysisId) return null
    return getDb().prepare(`
        SELECT id, mentor_id, suggested_text, comment, updated_at
        FROM mentor_feedback
        WHERE analysis_id = ? AND candidate_id = ? AND feedback_type = 'edit'
          AND status = 'accepted' AND suggestion_key = ? AND suggested_text != ''
        ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(analysisId, ownerId, sugKey(type, analysisId)) || null
}

// accepted mentor rewrite, else the candidate's own edit, else the ai original
export function effective(analysisId, ownerId, type) {
    if (!analysisId || !ownerId || !TYPES.has(type)) return null
    const db = getDb()

    // dismissing drops the row out of here, so the one under it goes current again
    const latest = db.prepare(`
        SELECT gd.id, gd.content, gd.company, gd.source, gd.author_id, gd.mentor_feedback_id,
               gd.comment, gd.created_at
        FROM generated_documents gd
        LEFT JOIN mentor_feedback mf ON mf.id = gd.mentor_feedback_id
        WHERE gd.analysis_id = ? AND gd.user_id = ? AND gd.document_type = ?
          AND (gd.mentor_feedback_id IS NULL OR mf.status = 'accepted')
        ORDER BY gd.created_at DESC, gd.id DESC LIMIT 1
    `).get(analysisId, ownerId, type)

    // pre-versioning acceptances only. check for the row, not the time - second-resolution
    // timestamps tie when an accept and an edit land in the same second
    const accepted = acceptedRewrite(analysisId, ownerId, type)
    const versioned = accepted && db.prepare(`
        SELECT 1 FROM generated_documents
        WHERE analysis_id = ? AND user_id = ? AND document_type = ? AND mentor_feedback_id = ?
        LIMIT 1
    `).get(analysisId, ownerId, type, accepted.id)
    if (accepted && !versioned && (!latest || String(latest.created_at) <= String(accepted.updated_at))) {
        return {
            id: null,
            content: accepted.suggested_text,
            company: latest?.company || getCompany(analysisId),
            source: "mentor",
            author_id: accepted.mentor_id,
            mentor_feedback_id: accepted.id,
            comment: accepted.comment || "",
            created_at: accepted.updated_at,
        }
    }
    return latest || null
}

// oldest first so numbering reads naturally
export function revs(analysisId, ownerId, type) {
    if (!analysisId || !ownerId || !TYPES.has(type)) return []
    return getDb().prepare(`
        SELECT gd.id, gd.content, gd.company, gd.source, gd.author_id, gd.mentor_feedback_id,
               gd.comment, gd.created_at, u.display_name AS author_name, u.role AS author_role
        FROM generated_documents gd
        LEFT JOIN users u ON u.id = gd.author_id
        WHERE gd.analysis_id = ? AND gd.user_id = ? AND gd.document_type = ?
        ORDER BY gd.created_at ASC, gd.id ASC
    `).all(analysisId, ownerId, type)
}
