import { getDb } from "./db.js"
import { mentorsFor } from "./access.js"
import { notifyMany } from "./notifications.js"
import { summaryOf } from "./summary.js"

// one place that writes an analysis row, whichever route produced the results
export function saveAnalysis({ userId, resumeId, results, jobDescription, provider, hash = "", attemptType = "resume_analysis" }) {
    const db = getDb()
    const score = typeof results.score === "object" ? results.score?.total || 0 : results.score || 0
    const summary = summaryOf(results)
    const row = db.prepare(`
        INSERT INTO analyses
            (resume_id, user_id, results_json, job_description, provider, model, score_total, content_hash,
             attempt_type, company, match_pct, score_json, timing_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
        resumeId, userId, JSON.stringify(results), jobDescription || "", provider || "", results.model || "",
        score, hash, attemptType, summary.company, summary.match_pct, summary.score_json, summary.timing_json,
    )
    const analysisId = Number(row.lastInsertRowid)
    results.analysis_id = analysisId
    results.resume_id = resumeId
    db.prepare("UPDATE analyses SET results_json = ? WHERE id = ?").run(JSON.stringify(results), analysisId)
    notifyMany(mentorsFor(userId), { analysisId, attemptType, eventType: "new_attempt" })
    return analysisId
}

// after the results change in place, e.g. a new job description
export function updateResults(analysisId, results, { jobDescription, hash }) {
    const summary = summaryOf(results)
    getDb().prepare(`
        UPDATE analyses SET job_description = ?, content_hash = ?, results_json = ?,
            company = ?, match_pct = ?, score_json = ?, timing_json = ?
        WHERE id = ?
    `).run(
        jobDescription, hash, JSON.stringify(results),
        summary.company, summary.match_pct, summary.score_json, summary.timing_json, analysisId,
    )
}
