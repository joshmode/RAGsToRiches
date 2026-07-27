import { Router } from "express"
import multer from "multer"
import crypto from "crypto"
import fetch from "node-fetch"
import { getDb } from "../db.js"
import { requireAuth } from "../middleware/auth.js"
import { canAccess, getAnalysis, getResume, mentorsFor } from "../access.js"
import { pollLimiter, llmLimiter } from "../middleware/rateLimit.js"
import { fetchEngine } from "../engineClient.js"
import { resolveProvider, ProviderError } from "../userKeys.js"
import { notifyMany } from "../notifications.js"
import { saveRev } from "../documents.js"

const router = Router()
const ANALYSIS_CACHE_TTL_MINUTES = parseInt(process.env.ANALYSIS_CACHE_TTL_MINUTES || "60", 10)
const PROVIDER_CHOICES = new Set(["default", "gemini", "claude", "chatgpt", "local"])

// same inputs = same result, cache it
function contentHash({ resumeId, jobDescription, provider, model, useCritic, localEndpoint }) {
    return crypto.createHash("sha256")
        .update(`${resumeId}|${provider || ""}|${model || ""}|${useCritic ? "1" : "0"}|${localEndpoint || ""}|${jobDescription || ""}`)
        .digest("hex")
}
const exts = new Set([".pdf", ".docx", ".doc", ".odt", ".txt", ".md", ".zip"])
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const name = file.originalname.toLowerCase()
        const ext = name.slice(name.lastIndexOf("."))
        cb(exts.has(ext) ? null : new Error("Unsupported resume format."), exts.has(ext))
    },
})

router.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." })
    }

    const engineUrl = req.app.locals.engineUrl
    const fileB64 = req.file.buffer.toString("base64")

    try {
        const resp = await fetch(`${engineUrl}/parse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: fileB64, filename: req.file.originalname }),
        })
        // forward the engine's own error
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const parsed = await resp.json()

        const row = getDb().prepare(
            "INSERT INTO resumes (user_id, filename, raw_bytes, parsed_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, req.file.originalname, req.file.buffer, JSON.stringify(parsed.sections))

        res.json({
            resume_id: row.lastInsertRowid,
            parsed,
            filename: req.file.originalname,
        })
    } catch (err) {
        res.status(500).json({ error: "The file could not be parsed. Please try a different file." })
    }
})

router.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Resume files must be 25 MB or smaller." : err.message })
    }
    if (err) return res.status(400).json({ error: err.message || "Upload failed." })
    next()
})

async function run(engineUrl, jobId, payload) {
    const db = getDb()
    db.prepare("UPDATE analysis_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(jobId)
    try {
        // resolved fresh
        const { engineProvider, apiKey } = resolveProvider(payload.user_id, payload.provider)
        const body = {
            resume_json: payload.resume_json,
            job_description: payload.job_description,
            provider: engineProvider,
            use_critic: payload.use_critic,
            local_endpoint: payload.local_endpoint,
            api_key: apiKey,
        }

        // alongside the analysis, not after 
        const [resp, gap] = await Promise.all([
            fetchEngine(`${engineUrl}/analyse`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            kwGap(
                engineUrl, payload.resume_json, payload.job_description,
                engineProvider, payload.local_endpoint, apiKey,
            ),
        ])
        if (!resp.ok) throw new Error((await resp.json()).error || "Analysis failed.")
        const results = await resp.json()
        results.parsed_resume = payload.resume_json
        results.job_description = payload.job_description || ""
        // analyse()'s own kw extraction wins, only take what it doesn't produce
        if (gap.company) results.company = gap.company
        if (typeof gap.match_pct === "number") results.match_pct = gap.match_pct
        if (gap.strong_matches) results.strong_matches = gap.strong_matches
        if (gap.tailoring_tips) results.tailoring_tips = gap.tailoring_tips
        const score = typeof results.score === "object" ? results.score.total || 0 : results.score || 0
        const hash = contentHash({
            resumeId: payload.resume_id, jobDescription: payload.job_description,
            provider: payload.provider, model: "", useCritic: payload.use_critic,
            localEndpoint: payload.local_endpoint,
        })
        const row = db.prepare(
            "INSERT INTO analyses (resume_id, user_id, results_json, job_description, provider, model, score_total, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
        ).run(
            payload.resume_id, payload.user_id, JSON.stringify(results), payload.job_description || "",
            payload.provider || "", "", score, hash,
        )
        results.analysis_id = row.lastInsertRowid
        results.resume_id = payload.resume_id
        db.prepare("UPDATE analyses SET results_json = ? WHERE id = ?").run(JSON.stringify(results), row.lastInsertRowid)
        db.prepare(
            "UPDATE analysis_jobs SET status = 'completed', analysis_id = ?, error = '', updated_at = datetime('now') WHERE id = ?"
        ).run(row.lastInsertRowid, jobId)
        notifyMany(mentorsFor(payload.user_id), { analysisId: row.lastInsertRowid, attemptType: "resume_analysis", eventType: "new_attempt" })
    } catch (err) {
        db.prepare(
            "UPDATE analysis_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(String(err.message || err).slice(0, 2000), jobId)
    }
}

router.post("/run", requireAuth, llmLimiter, (req, res) => {
    const { resume_json, job_description, provider, use_critic, local_endpoint, resume_id } = req.body
    const resumeId = parseInt(resume_id)
    if (!resumeId || !getResume(resumeId, req.user.id)) {
        return res.status(404).json({ error: "Resume not found." })
    }
    if (!PROVIDER_CHOICES.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }
    // fail fast if a byok provider has no key, don't queue and fail later
    try {
        resolveProvider(req.user.id, provider)
    } catch (err) {
        if (err instanceof ProviderError) return res.status(err.status).json({ error: err.message })
        throw err
    }

    // model is fixed per provider server-sid now never client-selected
    const payload = { resume_id: resumeId, user_id: req.user.id, resume_json, job_description, provider, use_critic, local_endpoint }
    const db = getDb()

    if (ANALYSIS_CACHE_TTL_MINUTES > 0) {
        const hash = contentHash({ resumeId, jobDescription: job_description, provider, model: "", useCritic: use_critic, localEndpoint: local_endpoint })
        const cached = db.prepare(
            `SELECT id FROM analyses WHERE user_id = ? AND content_hash = ? AND content_hash != '' AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 1`
        ).get(req.user.id, hash, `-${ANALYSIS_CACHE_TTL_MINUTES} minutes`)
        if (cached) {
            const job = db.prepare(
                "INSERT INTO analysis_jobs (resume_id, user_id, request_json, status, analysis_id, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, datetime('now'), datetime('now'))"
            ).run(resumeId, req.user.id, JSON.stringify(payload), cached.id)
            return res.status(202).json({ job_id: job.lastInsertRowid, status: "queued" })
        }
    }

    const row = db.prepare(
        "INSERT INTO analysis_jobs (resume_id, user_id, request_json, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', datetime('now'), datetime('now'))"
    ).run(resumeId, req.user.id, JSON.stringify(payload))
    run(req.app.locals.engineUrl, row.lastInsertRowid, payload)
    res.status(202).json({ job_id: row.lastInsertRowid, status: "queued" })
})

// the cheap kw gap compare-resume-jd already does reshaped for KeywordGap
async function kwGap(engineUrl, resumeJson, jobDescription, engineProvider, localEndpoint, apiKey) {
    if (!jobDescription || !jobDescription.trim()) return {}
    try {
        const res = await fetchEngine(`${engineUrl}/compare-resume-jd`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                resume_text: resumeJson?.raw_text || "", jd_text: jobDescription,
                provider: engineProvider, local_endpoint: localEndpoint || "", api_key: apiKey,
            }),
        })
        if (!res.ok) return {}
        const data = await res.json()
        return {
            jd_keywords: [...(data.strong_matches || []), ...(data.missing_skills || [])],
            missing_keywords: data.missing_skills || [],
            match_pct: data.match_pct || 0,
            strong_matches: data.strong_matches || [],
            tailoring_tips: data.tailoring_tips || [],
            company: data.company || "",
        }
    } catch {
        return {}
    }
}

// never touches analyse() 
router.post("/quick-cover-letter", requireAuth, llmLimiter, async (req, res) => {
    const { resume_json, job_description, provider, local_endpoint, resume_id, company } = req.body
    const resumeId = parseInt(resume_id)
    if (!resumeId || !getResume(resumeId, req.user.id)) {
        return res.status(404).json({ error: "Resume not found." })
    }
    if (!PROVIDER_CHOICES.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }
    let engineProvider, apiKey
    try {
        ({ engineProvider, apiKey } = resolveProvider(req.user.id, provider))
    } catch (err) {
        if (err instanceof ProviderError) return res.status(err.status).json({ error: err.message })
        throw err
    }

    const engineUrl = req.app.locals.engineUrl
    try {
        const resp = await fetchEngine(`${engineUrl}/gen-cover-letter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                resume_json, job_description: job_description || "",
                provider: engineProvider, local_endpoint: local_endpoint || "", api_key: apiKey,
            }),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = await resp.json()
        // the one extra thing this workflow gets
        const gap = await kwGap(engineUrl, resume_json, job_description, engineProvider, local_endpoint, apiKey)

        const db = getDb()
        // only what's derivable without analyse(). same shape as a real one so the sidebar works
        const stored = {
            contact: resume_json?.contact || {},
            sections: resume_json?.sections || {},
            parsed_resume: resume_json,
            job_description: job_description || "",
            attempt_type: "cover_letter_only",
            ...gap,
        }
        const row = db.prepare(
            "INSERT INTO analyses (resume_id, user_id, results_json, job_description, provider, model, score_total, content_hash, attempt_type, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, '', 'cover_letter_only', datetime('now'))"
        ).run(resumeId, req.user.id, JSON.stringify(stored), job_description || "", provider || "", "")
        const analysisId = row.lastInsertRowid
        stored.analysis_id = analysisId
        stored.resume_id = resumeId
        db.prepare("UPDATE analyses SET results_json = ? WHERE id = ?").run(JSON.stringify(stored), analysisId)
        // company off the jd beats the client
        saveRev({
            analysisId, ownerId: req.user.id, type: "cover_letter",
            content: data.cover_letter_text || "", source: "ai", authorId: req.user.id,
            company: gap.company || company,
        })
        notifyMany(mentorsFor(req.user.id), { analysisId, attemptType: "cover_letter_only", eventType: "new_attempt" })

        res.json({ analysis_id: analysisId, cover_letter_text: data.cover_letter_text || "", results: stored })
    } catch (err) {
        res.status(500).json({ error: "Cover letter generation failed. Please try again." })
    }
})

// jd-only change the resume invalidates the cache
router.post("/:id/refresh-jd", requireAuth, llmLimiter, async (req, res) => {
    const analysisId = parseInt(req.params.id)
    const row = getAnalysis(analysisId, req.user.id)
    if (!row) return res.status(404).json({ error: "Analysis not found." })
    const { job_description, provider, local_endpoint, company } = req.body
    if (!PROVIDER_CHOICES.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }
    let results = {}
    try { results = JSON.parse(row.results_json) } catch {}
    const resumeJson = results.parsed_resume
    if (!resumeJson) return res.status(409).json({ error: "This attempt has no stored resume data to regenerate against." })

    let engineProvider, apiKey
    try {
        ({ engineProvider, apiKey } = resolveProvider(req.user.id, provider))
    } catch (err) {
        if (err instanceof ProviderError) return res.status(err.status).json({ error: err.message })
        throw err
    }

    const engineUrl = req.app.locals.engineUrl
    try {
        const jd = job_description || ""
        const resp = await fetchEngine(`${engineUrl}/gen-cover-letter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resume_json: resumeJson, job_description: jd, provider: engineProvider, local_endpoint: local_endpoint || "", api_key: apiKey }),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = await resp.json()
        const gap = await kwGap(engineUrl, resumeJson, jd, engineProvider, local_endpoint, apiKey)

        const db = getDb()
        const out = { ...results, job_description: jd, ...gap }
        // clearing the jd has to wipe every field
        if (!jd.trim()) {
            out.jd_keywords = []
            out.missing_keywords = []
            out.match_pct = 0
            out.strong_matches = []
            out.tailoring_tips = []
            out.company = ""
        }
        // only a resume_analysis hash feedscache, leave the other alone
        const hash = row.attempt_type === "cover_letter_only" ? row.content_hash
            : contentHash({ resumeId: row.resume_id, jobDescription: jd, provider, model: row.model, useCritic: false, localEndpoint: local_endpoint })
        db.prepare("UPDATE analyses SET job_description = ?, content_hash = ?, results_json = ? WHERE id = ?")
            .run(jd, hash, JSON.stringify(out), analysisId)
        // real new version, the old letter stays in history
        saveRev({
            analysisId, ownerId: req.user.id, type: "cover_letter",
            content: data.cover_letter_text || "", source: "ai", authorId: req.user.id,
            company: out.company || company,
        })

        res.json({ analysis_id: analysisId, cover_letter_text: data.cover_letter_text || "", results: out })
    } catch (err) {
        res.status(500).json({ error: "Cover letter regeneration failed. Please try again." })
    }
})

router.get("/jobs/:jobId", requireAuth, pollLimiter, (req, res) => {
    const db = getDb()
    const job = db.prepare("SELECT * FROM analysis_jobs WHERE id = ? AND user_id = ?").get(req.params.jobId, req.user.id)
    if (!job) return res.status(404).json({ error: "Analysis job not found." })
    if (job.status === "completed" && job.analysis_id) {
        const analysis = getAnalysis(job.analysis_id, req.user.id)
        let results = {}
        try { results = JSON.parse(analysis.results_json) } catch {}
        return res.json({ id: job.id, status: job.status, analysis_id: job.analysis_id, results })
    }
    res.json({ id: job.id, status: job.status, error: job.error || "" })
})

router.post("/highlight", requireAuth, pollLimiter, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const resp = await fetch(`${engineUrl}/highlight-pdf`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = Buffer.from(await resp.arrayBuffer())
        res.setHeader("Content-Type", "application/pdf")
        res.setHeader("X-Active-Page", resp.headers.get("x-active-page") || "")
        res.send(data)
    } catch (err) {
        res.status(500).json({ error: "PDF highlighting failed. Please try again." })
    }
})

router.get("/history", requireAuth, (req, res) => {
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, resume_id, score_total, provider, model, attempt_type, results_json, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id)

    res.json(rows.map(r => {
        // already in results_json so return immediately 
        let results = {}
        try { results = JSON.parse(r.results_json) } catch {}
        const keywords = results.jd_keywords || []
        const missing = results.missing_keywords || []
        const kwPct = keywords.length ? Math.round((keywords.length - missing.length) / keywords.length * 100) : null
        return {
            id: r.id,
            resume_id: r.resume_id,
            score: r.score_total,
            provider: r.provider,
            model: r.model,
            attempt_type: r.attempt_type || "resume_analysis",
            company: results.company || "",
            job_match_pct: typeof results.match_pct === "number" ? results.match_pct : null,
            keyword_match_pct: kwPct,
            created_at: r.created_at,
        }
    }))
})

router.get("/insights/overview", requireAuth, (req, res) => {
    const db = getDb()
    // insights wants the newest last so resort ascending outside
    const rows = db.prepare(`
        SELECT * FROM (
            SELECT id, resume_id, results_json, score_total, provider, model, created_at
            FROM analyses WHERE user_id = ? AND attempt_type != 'cover_letter_only' ORDER BY created_at DESC LIMIT 50
        ) ORDER BY created_at ASC
    `).all(req.user.id)
    const analyses = rows.map(row => {
        let results = {}
        try { results = JSON.parse(row.results_json) } catch {}
        return {
            id: row.id,
            resume_id: row.resume_id,
            score: results.score || { total: row.score_total },
            timing: results.timing || {},
            provider: row.provider,
            model: row.model,
            created_at: row.created_at,
        }
    })
    res.json({ analyses })
})

router.get("/insights/delta", requireAuth, (req, res) => {
    // qs hands back an object
    const fromId = parseInt(req.query.from)
    const toId = parseInt(req.query.to)
    const from = fromId ? getAnalysis(fromId, req.user.id) : null
    const to = toId ? getAnalysis(toId, req.user.id) : null
    if (!from || !to) return res.status(404).json({ error: "Analysis not found." })
    let fromResults = {}
    let toResults = {}
    try { fromResults = JSON.parse(from.results_json) } catch {}
    try { toResults = JSON.parse(to.results_json) } catch {}
    const before = fromResults.score || {}
    const after = toResults.score || {}
    const keys = ["total", "base", "sections", "keywords", "bullet_quality", "action_verbs", "warnings"]
    const delta = Object.fromEntries(keys.map(key => [key, (after[key] || 0) - (before[key] || 0)]))
    res.json({ from: from.id, to: to.id, delta })
})

router.get("/resumes", requireAuth, (req, res) => {
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, filename, created_at FROM resumes WHERE user_id = ? ORDER BY created_at DESC"
    ).all(req.user.id)
    res.json(rows)
})

// reopening a past attempt needs the exact file it came from
router.get("/resumes/:resumeId/file", requireAuth, (req, res) => {
    const resume = getResume(req.params.resumeId, req.user.id)
    if (!resume) return res.status(404).json({ error: "Resume not found." })
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Disposition", `attachment; filename="${resume.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`)
    res.send(resume.raw_bytes)
})

router.get("/resumes/:resumeId/history", requireAuth, (req, res) => {
    if (!getResume(req.params.resumeId, req.user.id)) {
        return res.status(404).json({ error: "Resume not found." })
    }
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, analysis_id, decisions_json, score_total, created_at FROM revision_snapshots WHERE resume_id = ? ORDER BY created_at ASC"
    ).all(req.params.resumeId)
    res.json(rows.map(row => ({ ...row, decisions: JSON.parse(row.decisions_json || "{}") })))
})

router.get("/:id", requireAuth, (req, res) => {
    const row = canAccess(req.params.id, req.user)
    if (!row) {
        return res.status(404).json({ error: "Analysis not found." })
    }

    let results = {}
    try { results = JSON.parse(row.results_json) } catch {}
    res.json({ id: row.id, resume_id: row.resume_id, score: row.score_total, provider: row.provider, model: row.model, attempt_type: row.attempt_type || "resume_analysis", created_at: row.created_at, results })
})

router.post("/:id/decisions", requireAuth, (req, res) => {
    const { decisions } = req.body
    const analysisId = parseInt(req.params.id)
    if (!getAnalysis(analysisId, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()

    db.prepare("DELETE FROM rewrite_decisions WHERE analysis_id = ?").run(analysisId)

    const stmt = db.prepare(
        "INSERT INTO rewrite_decisions (analysis_id, suggestion_key, decision, created_at) VALUES (?, ?, ?, datetime('now'))"
    )
    db.transaction((items) => {
        for (const [key, val] of Object.entries(items)) {
            stmt.run(analysisId, key, val ? 1 : 0)
        }
    })(decisions || {})
    const analysis = getAnalysis(analysisId, req.user.id)
    db.prepare(
        "INSERT INTO revision_snapshots (resume_id, analysis_id, decisions_json, score_total, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(analysis.resume_id, analysisId, JSON.stringify(decisions || {}), analysis.score_total)
    res.json({ ok: true })
})

router.get("/:id/decisions", requireAuth, (req, res) => {
    if (!canAccess(req.params.id, req.user)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const db = getDb()
    const rows = db.prepare("SELECT suggestion_key, decision FROM rewrite_decisions WHERE analysis_id = ?").all(req.params.id)
    const decisions = {}
    for (const r of rows) {
        decisions[r.suggestion_key] = r.decision === 1
    }
    res.json(decisions)
})

router.get("/:id/revisions", requireAuth, (req, res) => {
    const analysis = canAccess(req.params.id, req.user)
    if (!analysis) return res.status(404).json({ error: "Analysis not found." })
    const db = getDb()
    const rows = db.prepare(
        "SELECT id, decisions_json, score_total, created_at FROM revision_snapshots WHERE analysis_id = ? ORDER BY created_at ASC"
    ).all(analysis.id)
    res.json(rows.map(row => ({ ...row, decisions: JSON.parse(row.decisions_json || "{}") })))
})

export default router
