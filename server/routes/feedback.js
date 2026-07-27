import { Router } from "express"
import { getDb } from "../db.js"
import { requireAuth } from "../middleware/auth.js"
import { getAnalysis } from "../access.js"

const router = Router()

router.post("/", requireAuth, (req, res) => {
    const { analysis_id, consent, confidence, comment } = req.body
    if (!consent) return res.status(400).json({ error: "Evaluation consent is required." })
    // analysis_id makes better-sqlite3 throw, see annotations.js
    const analysisId = analysis_id ? parseInt(analysis_id) : null
    if (analysis_id && (!analysisId || !getAnalysis(analysisId, req.user.id))) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const score = confidence === undefined || confidence === "" ? null : Number(confidence)
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) {
        return res.status(400).json({ error: "Confidence must be between 1 and 5." })
    }
    const row = getDb().prepare(
        "INSERT INTO evaluation_feedback (user_id, analysis_id, consent, confidence, comment, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(req.user.id, analysisId || null, 1, score, String(comment || "").trim().slice(0, 2000))
    res.status(201).json({ id: row.lastInsertRowid, ok: true })
})

export default router
