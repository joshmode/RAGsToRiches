import { Router } from "express"
import { getDb } from "../db.js"
import { requireAuth, requireRole } from "../middleware/auth.js"
import { canAccess, mentorSession, mentorsFor } from "../access.js"
import { notify, notifyMany } from "../notifications.js"
import { saveRev, effective, getCompany } from "../documents.js"
import crypto from "crypto"

const router = Router()



// rank across all of a candidate's analyses
function attemptNums(db, candidateId) {
    const rows = db.prepare("SELECT id FROM analyses WHERE user_id = ? ORDER BY created_at ASC, id ASC").all(candidateId)
    const map = {}
    rows.forEach((r, i) => { map[r.id] = i + 1 })
    return map
}

// accepted rewrites applied so the diff shows real revisions
function appliedSections(results) {
    const sections = results?.parsed_resume?.sections || results?.sections || {}
    const rewrites = results?.rewrites || {}
    const decisions = results?.decisions || {}
    const out = {}
    for (const [sec, lines] of Object.entries(sections)) {
        const byIdx = {}
        for (const item of rewrites[sec] || []) {
            if (decisions[item.id] === true && Array.isArray(item.line_indices) && item.line_indices.length) {
                byIdx[item.line_indices[0]] = item
            }
        }
        const applied = []
        let skipUntil = -1
        lines.forEach((line, idx) => {
            if (idx <= skipUntil) return
            const item = byIdx[idx]
            if (item) {
                applied.push(item.rewritten || line)
                skipUntil = Math.max(...item.line_indices)
            } else {
                applied.push(line)
            }
        })
        out[sec] = applied
    }
    return out
}

function loadAnalysis(db, analysisId) {
    const row = db.prepare("SELECT * FROM analyses WHERE id = ?").get(analysisId)
    if (!row) return null
    let results = {}
    try { results = JSON.parse(row.results_json) } catch {}
    const decisions = {}
    for (const r of db.prepare("SELECT suggestion_key, decision FROM rewrite_decisions WHERE analysis_id = ?").all(analysisId)) {
        decisions[r.suggestion_key] = r.decision === 1
    }
    results.decisions = decisions
    return { row, results }
}

router.get("/dashboard", requireAuth, requireRole("mentor"), (req, res) => {
    const db = getDb()

    const sessions = db.prepare(
        "SELECT id, session_code, active, created_at FROM review_sessions WHERE mentor_id = ? ORDER BY created_at DESC"
    ).all(req.user.id)

    const candidates = {}
    for (const sess of sessions) {
        const parts = db.prepare(
            "SELECT u.id, u.username, u.display_name FROM users u JOIN session_participants sp ON sp.user_id = u.id WHERE sp.session_id = ? AND u.role = 'candidate'"
        ).all(sess.id)

        for (const u of parts) {
            if (!candidates[u.id]) {
                const analyses = db.prepare(
                    "SELECT id, score_total, provider, model, attempt_type, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
                ).all(u.id)

                // never scored, that 0 isn't a real low score. total still counts them
                const scored = analyses.filter(a => a.attempt_type !== "cover_letter_only")
                const scores = scored.map(a => a.score_total)
                candidates[u.id] = {
                    id: u.id,
                    name: u.display_name,
                    username: u.username,
                    total_analyses: analyses.length,
                    latest_score: scores[0] || 0,
                    best_score: scores.length ? Math.max(...scores) : 0,
                    scores,
                    analyses,
                }
            }
        }
    }

    const out = sessions.map(s => {
        const participants = db.prepare(
            "SELECT u.id, u.username, u.display_name, u.role FROM users u JOIN session_participants sp ON sp.user_id = u.id WHERE sp.session_id = ?"
        ).all(s.id)
        return { ...s, participants }
    })

    res.json({
        sessions: out,
        candidates: Object.values(candidates),
    })
})

router.post("/session", requireAuth, requireRole("mentor"), (req, res) => {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 8)
    const db = getDb()
    db.prepare(
        "INSERT INTO review_sessions (mentor_id, session_code, active, created_at) VALUES (?, ?, 1, datetime('now'))"
    ).run(req.user.id, code)

    res.status(201).json({ code })
})

router.post("/session/join", requireAuth, requireRole("candidate"), (req, res) => {
    const { code } = req.body
    if (!code?.trim()) {
        return res.status(400).json({ error: "Session code is required." })
    }

    const db = getDb()
    const session = db.prepare(
        "SELECT id FROM review_sessions WHERE session_code = ? AND active = 1"
    ).get(code.trim().toUpperCase())

    if (!session) {
        return res.status(404).json({ error: "Invalid or inactive session code." })
    }

    const existing = db.prepare(
        "SELECT id FROM session_participants WHERE session_id = ? AND user_id = ?"
    ).get(session.id, req.user.id)

    if (!existing) {
        db.prepare(
            "INSERT INTO session_participants (session_id, user_id, joined_at) VALUES (?, ?, datetime('now'))"
        ).run(session.id, req.user.id)
    }

    res.json({ ok: true, session_id: session.id })
})

router.post("/session/:code/close", requireAuth, requireRole("mentor"), (req, res) => {
    const db = getDb()
    const result = db.prepare(
        "UPDATE review_sessions SET active = 0 WHERE session_code = ? AND mentor_id = ?"
    ).run(req.params.code.toUpperCase(), req.user.id)
    if (!result.changes) return res.status(404).json({ error: "Session not found." })
    res.json({ ok: true })
})

router.get("/session/:code/participants", requireAuth, requireRole("mentor"), (req, res) => {
    const db = getDb()
    const session = db.prepare("SELECT id FROM review_sessions WHERE session_code = ? AND mentor_id = ?").get(req.params.code.toUpperCase(), req.user.id)
    if (!session) {
        return res.status(404).json({ error: "Session not found." })
    }

    const rows = db.prepare(
        "SELECT u.id, u.username, u.display_name, u.role FROM users u JOIN session_participants sp ON sp.user_id = u.id WHERE sp.session_id = ?"
    ).all(session.id)

    res.json(rows)
})

// every analysis + revision snapshot for one candidate
router.get("/candidates/:candidateId/history", requireAuth, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSession(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const attemptOf = attemptNums(db, candidateId)
    const analyses = db.prepare(
        "SELECT id, resume_id, score_total, provider, model, job_description, attempt_type, results_json, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(candidateId)
    const snapshots = db.prepare(`
        SELECT rs.id, rs.resume_id, rs.analysis_id, rs.decisions_json, rs.score_total, rs.created_at
        FROM revision_snapshots rs JOIN analyses a ON a.id = rs.analysis_id
        WHERE a.user_id = ? ORDER BY rs.created_at DESC LIMIT 100
    `).all(candidateId)
    res.json({
        // same fields the candidate's own history gives
        analyses: analyses.map(a => {
            let results = {}
            try { results = JSON.parse(a.results_json) } catch {}
            const keywords = results.jd_keywords || []
            const missing = results.missing_keywords || []
            const kwPct = keywords.length ? Math.round((keywords.length - missing.length) / keywords.length * 100) : null
            const { results_json, ...rest } = a
            return {
                ...rest,
                attempt_number: attemptOf[a.id] || null,
                company: results.company || "",
                job_match_pct: typeof results.match_pct === "number" ? results.match_pct : null,
                keyword_match_pct: kwPct,
            }
        }),
        revisions: snapshots.map(s => ({ ...s, decisions: JSON.parse(s.decisions_json || "{}") })),
    })
})

// full analysis detail, same shape the candidate sees
router.get("/candidates/:candidateId/analyses/:analysisId", requireAuth, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSession(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const loaded = loadAnalysis(db, parseInt(req.params.analysisId))
    if (!loaded || loaded.row.user_id !== candidateId) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    res.json({
        id: loaded.row.id, resume_id: loaded.row.resume_id, score: loaded.row.score_total, provider: loaded.row.provider,
        model: loaded.row.model, attempt_type: loaded.row.attempt_type || "resume_analysis", created_at: loaded.row.created_at, results: loaded.results,
    })
})

// the original upload, highlighted the same way the candidate's own view does
router.get("/candidates/:candidateId/resumes/:resumeId/file", requireAuth, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSession(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const resume = db.prepare("SELECT filename, raw_bytes FROM resumes WHERE id = ? AND user_id = ?").get(parseInt(req.params.resumeId), candidateId)
    if (!resume) return res.status(404).json({ error: "Resume not found." })
    if (!resume.filename.toLowerCase().endsWith(".pdf")) {
        return res.status(415).json({ error: "Source preview is only available for PDF uploads." })
    }
    res.setHeader("Content-Type", "application/pdf")
    res.send(resume.raw_bytes)
})

// what the candidate actually generated, falling back to plain markdown if there's no cv
router.get("/candidates/:candidateId/analyses/:analysisId/preview", requireAuth, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSession(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const loaded = loadAnalysis(db, parseInt(req.params.analysisId))
    if (!loaded || loaded.row.user_id !== candidateId) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    // same effective doc the candidate sees 
    const rev = effective(loaded.row.id, candidateId, "cv")
    if (rev) return res.json({ markdown: rev.content, source: rev.source })

    const sections = appliedSections(loaded.results)
    const contact = loaded.results.parsed_resume?.contact || loaded.results.contact || {}
    let md = contact.name ? `# ${contact.name}\n\n` : "# Resume\n\n"
    for (const [sec, lines] of Object.entries(sections)) {
        md += `## ${sec}\n---\n` + lines.map(l => `- ${l}`).join("\n") + "\n\n"
    }
    res.json({ markdown: md, source: "applied_sections" })
})

// like /preview but for a cover letter and use current saved version, not the first draft
router.get("/candidates/:candidateId/analyses/:analysisId/cover-letter", requireAuth, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSession(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const analysisId = parseInt(req.params.analysisId)
    const row = db.prepare("SELECT id FROM analyses WHERE id = ? AND user_id = ?").get(analysisId, candidateId)
    if (!row) return res.status(404).json({ error: "Analysis not found." })
    const rev = effective(analysisId, candidateId, "cover_letter")
    res.json({
        content: rev ? rev.content : "",
        source: rev ? rev.source : "",
        company: getCompany(analysisId),
    })
})

// cover letter compare, same company only
router.get("/candidates/:candidateId/cover-letter-diff", requireAuth, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSession(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const from = db.prepare("SELECT * FROM analyses WHERE id = ? AND user_id = ?").get(parseInt(req.query.from), candidateId)
    const to = db.prepare("SELECT * FROM analyses WHERE id = ? AND user_id = ?").get(parseInt(req.query.to), candidateId)
    if (!from || !to) return res.status(404).json({ error: "Analysis not found." })
    if (from.attempt_type !== "cover_letter_only" || to.attempt_type !== "cover_letter_only") {
        return res.status(400).json({ error: "Both attempts must be Cover Letter attempts to compare." })
    }
    let fromResults = {}, toResults = {}
    try { fromResults = JSON.parse(from.results_json) } catch {}
    try { toResults = JSON.parse(to.results_json) } catch {}
    const fromCompany = String(fromResults.company || "").trim().toLowerCase()
    const toCompany = String(toResults.company || "").trim().toLowerCase()
    if (fromCompany !== toCompany) {
        return res.status(400).json({ error: "Cover letters must be for the same company to compare." })
    }
    // each side is that attempt's effective letter, not a first draft
    const a = effective(from.id, candidateId, "cover_letter")
    const b = effective(to.id, candidateId, "cover_letter")
    res.json({
        from: { id: from.id, company: getCompany(from.id), created_at: from.created_at },
        to: { id: to.id, company: getCompany(to.id), created_at: to.created_at },
        before: a?.content || "",
        after: b?.content || "",
    })
})

// per-section diff between two analyses of the same candidate
router.get("/candidates/:candidateId/diff", requireAuth, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSession(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const from = loadAnalysis(db, parseInt(req.query.from))
    const to = loadAnalysis(db, parseInt(req.query.to))
    if (!from || !to || from.row.user_id !== candidateId || to.row.user_id !== candidateId) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const before = appliedSections(from.results)
    const after = appliedSections(to.results)
    const names = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    const sections = names.map(name => ({
        section: name,
        before: (before[name] || []).join("\n"),
        after: (after[name] || []).join("\n"),
    }))
    res.json({
        from: { id: from.row.id, score: from.row.score_total, created_at: from.row.created_at },
        to: { id: to.row.id, score: to.row.score_total, created_at: to.row.created_at },
        sections,
    })
})

// mentor-only, candidates just get their latest via /generate/latest
router.get("/candidates/:candidateId/cover-letters", requireAuth, requireRole("mentor"), (req, res) => {
    const candidateId = parseInt(req.params.candidateId)
    if (!mentorSession(req.user.id, candidateId, { activeOnly: false })) {
        return res.status(404).json({ error: "Candidate not found in your review sessions." })
    }
    const db = getDb()
    const attemptOf = attemptNums(db, candidateId)
    const rows = db.prepare(`
        SELECT gd.id, gd.analysis_id, gd.company, gd.content, gd.created_at
        FROM generated_documents gd JOIN analyses a ON a.id = gd.analysis_id
        WHERE a.user_id = ? AND gd.document_type = 'cover_letter'
        ORDER BY gd.created_at DESC LIMIT 100
    `).all(candidateId)
    res.json(rows.map(r => ({ ...r, attempt_number: attemptOf[r.analysis_id] || null })))
})

// a comment, a bullet edit, or a whole-section edit see sectionOverrides for full
router.post("/feedback", requireAuth, requireRole("mentor"), (req, res) => {
    const { candidate_id, analysis_id, suggestion_key, feedback_type, section, original_text, suggested_text, comment } = req.body
    const candidateId = parseInt(candidate_id)
    const session = mentorSession(req.user.id, candidateId)
    if (!session) {
        return res.status(404).json({ error: "Candidate not found in your active review sessions." })
    }
    const type = ["edit", "section_edit"].includes(feedback_type) ? feedback_type : "comment"
    if ((type === "edit" || type === "section_edit") && !String(suggested_text || "").trim()) {
        return res.status(400).json({ error: "Edit suggestions need suggested text." })
    }
    if (type === "section_edit" && !String(section || "").trim()) {
        return res.status(400).json({ error: "A section edit must specify which section it applies to." })
    }
    if (type === "comment" && !String(comment || "").trim()) {
        return res.status(400).json({ error: "Comment cannot be empty." })
    }
    // canAccess only proves they can reach some analysis not this candidate
    const analysisId = analysis_id ? parseInt(analysis_id) : null
    let analysisRow = null
    if (analysis_id) {
        analysisRow = analysisId ? canAccess(analysisId, req.user) : null
        if (!analysisRow || analysisRow.user_id !== candidateId) {
            return res.status(404).json({ error: "Analysis not found." })
        }
    }
    const db = getDb()
    const row = db.prepare(`
        INSERT INTO mentor_feedback
            (session_id, mentor_id, candidate_id, analysis_id, suggestion_key, feedback_type, section, original_text, suggested_text, comment, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
        session.id, req.user.id, candidateId, analysisId, String(suggestion_key || ""),
        type, String(section || ""), String(original_text || ""), String(suggested_text || ""), String(comment || ""),
    )
    notify(candidateId, { analysisId, attemptType: analysisRow?.attempt_type || "resume_analysis", eventType: "mentor_feedback" })
    res.status(201).json({ id: row.lastInsertRowid })
})

// what the mentor has sent
router.get("/feedback", requireAuth, requireRole("mentor"), (req, res) => {
    const db = getDb()
    const candidateId = req.query.candidate_id ? parseInt(req.query.candidate_id) : null
    const rows = candidateId
        ? db.prepare(`
            SELECT mf.*, u.display_name AS candidate_name, a.attempt_type FROM mentor_feedback mf
            JOIN users u ON u.id = mf.candidate_id
            LEFT JOIN analyses a ON a.id = mf.analysis_id
            WHERE mf.mentor_id = ? AND mf.candidate_id = ? ORDER BY mf.created_at DESC LIMIT 200
          `).all(req.user.id, candidateId)
        : db.prepare(`
            SELECT mf.*, u.display_name AS candidate_name, a.attempt_type FROM mentor_feedback mf
            JOIN users u ON u.id = mf.candidate_id
            LEFT JOIN analyses a ON a.id = mf.analysis_id
            WHERE mf.mentor_id = ? ORDER BY mf.created_at DESC LIMIT 200
          `).all(req.user.id)
    const nums = {}
    res.json(rows.map(r => {
        if (!r.analysis_id) return { ...r, attempt_number: null }
        if (!nums[r.candidate_id]) nums[r.candidate_id] = attemptNums(db, r.candidate_id)
        return { ...r, attempt_number: nums[r.candidate_id][r.analysis_id] || null }
    }))
})

// candidate side, newest first
router.get("/feedback/inbox", requireAuth, (req, res) => {
    const db = getDb()
    const rows = db.prepare(`
        SELECT mf.*, u.display_name AS mentor_name, a.attempt_type FROM mentor_feedback mf
        JOIN users u ON u.id = mf.mentor_id
        LEFT JOIN analyses a ON a.id = mf.analysis_id
        WHERE mf.candidate_id = ? ORDER BY mf.created_at DESC LIMIT 200
    `).all(req.user.id)
    const attemptOf = attemptNums(db, req.user.id)
    res.json(rows.map(r => ({ ...r, attempt_number: r.analysis_id ? (attemptOf[r.analysis_id] || null) : null })))
})

// splits and inserts a rewritten section into a cv
function replaceCvSection(markdown, section, replacement) {
    const header = `## ${section}`
    const idx = markdown.indexOf(header)
    if (idx === -1) return null
    const afterHeader = idx + header.length
    const nextSection = markdown.indexOf("\n## ", afterHeader)
    const tail = nextSection !== -1 ? markdown.slice(nextSection) : ""
    return markdown.slice(0, afterHeader) + "\n" + replacement + "\n" + tail
}

// accepting writes the new version straight away so nothing needs a regenerate
router.post("/feedback/:id/status", requireAuth, (req, res) => {
    const status = String(req.body.status || "")
    if (!["open", "accepted", "dismissed"].includes(status)) {
        return res.status(400).json({ error: "Status must be open, accepted, or dismissed." })
    }
    const db = getDb()
    const feedbackId = parseInt(req.params.id)
    const result = db.prepare(
        "UPDATE mentor_feedback SET status = ?, updated_at = datetime('now') WHERE id = ? AND candidate_id = ?"
    ).run(status, feedbackId, req.user.id)
    if (!result.changes) return res.status(404).json({ error: "Feedback not found." })

    const fb = db.prepare("SELECT * FROM mentor_feedback WHERE id = ?").get(feedbackId)
    const response = { ok: true, analysis_id: fb?.analysis_id || null, document_type: null }
    if (!fb) return res.json(response)

    const analysisRow = fb.analysis_id ? db.prepare("SELECT attempt_type FROM analyses WHERE id = ?").get(fb.analysis_id) : null
    const attemptType = analysisRow?.attempt_type || "resume_analysis"

    if (status === "accepted" && fb.analysis_id && fb.suggested_text) {
        // whole-doc rewrite goes in 
        const wholeDoc = fb.feedback_type !== "edit" ? null
            : fb.suggestion_key === `cover_letter:${fb.analysis_id}` ? "cover_letter"
            : fb.suggestion_key === `preview:${fb.analysis_id}` ? "cv" : null

        if (wholeDoc) {
            saveRev({
                analysisId: fb.analysis_id, ownerId: req.user.id, type: wholeDoc,
                content: fb.suggested_text, source: "mentor", authorId: fb.mentor_id,
                mentorFeedbackId: fb.id, comment: fb.comment,
            })
            response.document_type = wholeDoc
            response.content = fb.suggested_text
        } else if (fb.feedback_type === "section_edit" && fb.section) {
            // spliced into the current cv so only that section changes
            const current = effective(fb.analysis_id, req.user.id, "cv")
            const patched = current ? replaceCvSection(current.content, fb.section, fb.suggested_text) : null
            if (patched) {
                saveRev({
                    analysisId: fb.analysis_id, ownerId: req.user.id, type: "cv",
                    content: patched, source: "mentor", authorId: fb.mentor_id,
                    mentorFeedbackId: fb.id, comment: fb.comment,
                })
                response.document_type = "cv"
                response.content = patched
            }
        }
    }

    // notify either way a dismissal starts the next revision cycle
    notify(fb.mentor_id, {
        analysisId: fb.analysis_id, attemptType,
        eventType: status === "accepted" ? "feedback_accepted"
            : status === "dismissed" ? "feedback_dismissed" : "feedback_reopened",
    })
    res.json(response)
})

router.get("/report", requireAuth, requireRole("mentor"), (req, res) => {
    const db = getDb()
    const sessions = db.prepare("SELECT id FROM review_sessions WHERE mentor_id = ?").all(req.user.id)

    const candidates = {}
    for (const sess of sessions) {
        const parts = db.prepare(
            "SELECT u.id, u.username, u.display_name FROM users u JOIN session_participants sp ON sp.user_id = u.id WHERE sp.session_id = ? AND u.role = 'candidate'"
        ).all(sess.id)
        for (const u of parts) {
            if (!candidates[u.id]) {
                const analyses = db.prepare("SELECT score_total, attempt_type FROM analyses WHERE user_id = ? ORDER BY created_at DESC").all(u.id)
                // never scored
                const scores = analyses.filter(a => a.attempt_type !== "cover_letter_only").map(a => a.score_total)
                candidates[u.id] = { name: u.display_name, username: u.username, scores, total: analyses.length, latest: scores[0] || 0, best: scores.length ? Math.max(...scores) : 0 }
            }
        }
    }

    let md = "# Mentor Review Report\n\n"
    for (const c of Object.values(candidates)) {
        md += `## ${c.name} (@${c.username})\n`
        md += `- Total analyses: ${c.total}\n`
        md += `- Latest score: ${c.latest}/100\n`
        md += `- Best score: ${c.best}/100\n`
        if (c.scores.length) md += `- Score history: ${[...c.scores].reverse().join(", ")}\n`
        md += "\n"
    }

    res.json({ report: md })
})

export default router
