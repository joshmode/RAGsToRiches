import { Router } from "express"
import { getDb } from "../db.js"
import { requireAuth } from "../middleware/auth.js"
import { canAccess, mentorsFor } from "../access.js"
import { notify, notifyMany } from "../notifications.js"

const router = Router()

//a reply is just the next row
router.get("/:analysisId", requireAuth, (req, res) => {
    if (!canAccess(req.params.analysisId, req.user)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()
    const rows = db.prepare(
        "SELECT a.id, a.suggestion_key, a.section, a.comment, a.created_at, a.user_id, u.display_name, u.role FROM annotations a JOIN users u ON a.user_id = u.id WHERE a.analysis_id = ? ORDER BY a.created_at ASC, a.id ASC"
    ).all(req.params.analysisId)

    res.json(rows.map(r => ({
        id: r.id,
        key: r.suggestion_key,
        section: r.section,
        comment: r.comment,
        user: r.display_name,
        user_id: r.user_id,
        role: r.role,
        time: r.created_at,
    })))
})

router.post("/", requireAuth, (req, res) => {
    const { analysis_id, suggestion_key, comment, section } = req.body
    // out of json, so it can be an object 
    const analysisId = (typeof analysis_id === "number" || typeof analysis_id === "string") ? parseInt(analysis_id) : NaN

    if (typeof suggestion_key !== "string" || typeof comment !== "string" ||
        !analysisId || !suggestion_key || !comment.trim()) {
        return res.status(400).json({ error: "analysis_id, suggestion_key, and comment are required." })
    }
    const analysisRow = canAccess(analysisId, req.user)
    if (!analysisRow) {
        return res.status(404).json({ error: "Analysis not found." })
    }

    const row = getDb().prepare(
        "INSERT INTO annotations (analysis_id, user_id, suggestion_key, comment, section, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(analysisId, req.user.id, suggestion_key, comment.trim(), typeof section === "string" ? section.slice(0, 100) : "")

    // notify whichever side didn't post
    const attemptType = analysisRow.attempt_type || "resume_analysis"
    if (req.user.role === "mentor") {
        notify(analysisRow.user_id, { analysisId, attemptType, eventType: "discussion_reply" })
    } else {
        notifyMany(mentorsFor(req.user.id), { analysisId, attemptType, eventType: "user_comment" })
    }

    res.status(201).json({ id: row.lastInsertRowid, ok: true })
})

export default router
