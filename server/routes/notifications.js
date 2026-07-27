import { Router } from "express"
import { getDb } from "../db.js"
import { requireAuth } from "../middleware/auth.js"

const router = Router()

// one endpoint behind every unread badge
router.get("/summary", requireAuth, (req, res) => {
    const rows = getDb().prepare(`
        SELECT n.id, n.analysis_id, n.attempt_type, n.event_type, a.user_id AS candidate_id
        FROM notifications n LEFT JOIN analyses a ON a.id = n.analysis_id
        WHERE n.user_id = ? AND n.read = 0
    `).all(req.user.id)

    const byType = {}
    const byAnalysis = {}
    const byCand = {}
    // per-candidate per-workflow so the history toggle badges only the one with activity and is separate
    const byCandType = {}
    for (const r of rows) {
        byType[r.attempt_type] = (byType[r.attempt_type] || 0) + 1
        if (r.analysis_id) byAnalysis[r.analysis_id] = (byAnalysis[r.analysis_id] || 0) + 1
        if (r.candidate_id) {
            byCand[r.candidate_id] = (byCand[r.candidate_id] || 0) + 1
            const per = byCandType[r.candidate_id] || (byCandType[r.candidate_id] = {})
            per[r.attempt_type] = (per[r.attempt_type] || 0) + 1
        }
    }
    res.json({
        unread_total: rows.length,
        by_attempt_type: byType,
        by_analysis_id: byAnalysis,
        by_candidate_id: byCand,
        by_candidate_and_type: byCandType,
    })
})

// viewing clears unread a later visit can badge again
router.post("/mark-read", requireAuth, (req, res) => {
    const analysisId = req.body.analysis_id ? parseInt(req.body.analysis_id) : null
    if (!analysisId) return res.status(400).json({ error: "analysis_id is required." })
    getDb().prepare(
        "UPDATE notifications SET read = 1 WHERE user_id = ? AND analysis_id = ? AND read = 0"
    ).run(req.user.id, analysisId)
    res.json({ ok: true })
})

export default router
