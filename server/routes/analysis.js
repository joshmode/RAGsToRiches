import { Router } from "express"
import multer from "multer"
import crypto from "crypto"
import fetch from "node-fetch"
import { getDb } from "../db.js"
import { requireAuth } from "../middleware/auth.js"
import { canAccess, getAnalysis, getResume } from "../access.js"
import { pollLimiter, llmLimiter } from "../middleware/rateLimit.js"
import { fetchEngine } from "../engineClient.js"
import { resolveProvider, ProviderError, PROVIDER_CHOICES } from "../userKeys.js"
import { saveRev } from "../documents.js"
import { saveAnalysis, updateResults } from "../analyses.js"
import { parseSSEBuffer } from "../sse.js"

const router = Router()
const ANALYSIS_CACHE_TTL_MINUTES = parseInt(process.env.ANALYSIS_CACHE_TTL_MINUTES || "60", 10)

// same inputs = same result, cache it. keyed on the file's bytes, not on the resume
// row, which used to be new on every upload so the cache never hit from the ui
function contentHash({ fileKey, jobDescription, provider, useCritic, localEndpoint }) {
    return crypto.createHash("sha256")
        .update(`${fileKey}|${provider || ""}|${useCritic ? "1" : "0"}|${localEndpoint || ""}|${jobDescription || ""}`)
        .digest("hex")
}

// rows from before file hashing fall back to their own id
function fileKey(resume) {
    return resume.file_hash || `resume:${resume.id}`
}

// the full parse stored on a resume row. older rows kept only the sections
function storedParse(resume) {
    try {
        const parsed = JSON.parse(resume?.parsed_json || "null")
        return parsed && parsed.sections && typeof parsed.raw_text === "string" ? parsed : null
    } catch {
        return null
    }
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
    const name = req.file.originalname.toLowerCase()
    // the extension picks the parser, so the same bytes as .md and .txt aren't the same file
    const fileHash = crypto.createHash("sha256")
        .update(`${name.slice(name.lastIndexOf("."))}|`).update(req.file.buffer).digest("hex")
    const db = getDb()

    // the same file again: reuse its row and parse, so re-analysing doesn't re-parse
    // (or re-OCR) it or store another copy
    const existing = db.prepare(
        "SELECT * FROM resumes WHERE user_id = ? AND file_hash = ? ORDER BY id DESC LIMIT 1"
    ).get(req.user.id, fileHash)
    const known = storedParse(existing)
    if (known) {
        return res.json({ resume_id: existing.id, parsed: known, filename: existing.filename, reused: true })
    }

    try {
        const resp = await fetch(`${engineUrl}/parse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: fileB64, filename: req.file.originalname }),
        })
        // forward the engine's own error
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const parsed = await resp.json()

        if (existing) {
            db.prepare("UPDATE resumes SET parsed_json = ? WHERE id = ?").run(JSON.stringify(parsed), existing.id)
            return res.json({ resume_id: existing.id, parsed, filename: existing.filename })
        }
        const row = db.prepare(
            "INSERT INTO resumes (user_id, filename, raw_bytes, parsed_json, file_hash, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, req.file.originalname, req.file.buffer, JSON.stringify(parsed), fileHash)

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

        // analyse() reads the jd once and returns the job fit with the rewrites,
        // so there's no second model call to make or to disagree with
        const resp = await fetchEngine(`${engineUrl}/analyse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
        if (!resp.ok) throw new Error((await resp.json()).error || "Analysis failed.")
        const results = await resp.json()
        results.parsed_resume = payload.resume_json
        results.job_description = payload.job_description || ""
        const analysisId = saveAnalysis({
            userId: payload.user_id, resumeId: payload.resume_id, results,
            jobDescription: payload.job_description, provider: payload.provider,
            hash: contentHash({
                fileKey: payload.file_key || `resume:${payload.resume_id}`, jobDescription: payload.job_description,
                provider: payload.provider, useCritic: payload.use_critic, localEndpoint: payload.local_endpoint,
            }),
        })
        db.prepare(
            "UPDATE analysis_jobs SET status = 'completed', analysis_id = ?, error = '', updated_at = datetime('now') WHERE id = ?"
        ).run(analysisId, jobId)
    } catch (err) {
        db.prepare(
            "UPDATE analysis_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(String(err.message || err).slice(0, 2000), jobId)
    }
}

// the newest cached analysis for these exact inputs, if there's one in the ttl
function cachedAnalysis(userId, hash) {
    if (ANALYSIS_CACHE_TTL_MINUTES <= 0) return null
    return getDb().prepare(
        `SELECT id FROM analyses WHERE user_id = ? AND content_hash = ? AND content_hash != '' AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 1`
    ).get(userId, hash, `-${ANALYSIS_CACHE_TTL_MINUTES} minutes`)
}

const SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
}

// Streams analysis progress from the engine as server-sent events, so a long
// analysis fills in batch by batch instead of landing all at once. The final
// event is saved like any other analysis and carries its analysis_id, and the
// same inputs again are answered from the cache without touching the engine.
router.post("/stream", requireAuth, llmLimiter, async (req, res) => {
    const { job_description, provider, use_critic, local_endpoint, resume_id } = req.body
    const resumeId = parseInt(resume_id)
    const resume = resumeId ? getResume(resumeId, req.user.id) : null
    if (!resume) {
        return res.status(404).json({ error: "Resume not found." })
    }
    const resume_json = storedParse(resume) || req.body.resume_json
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

    const hash = contentHash({ fileKey: fileKey(resume), jobDescription: job_description, provider, useCritic: use_critic, localEndpoint: local_endpoint })
    const cached = cachedAnalysis(req.user.id, hash)
    if (cached) {
        let results = {}
        try { results = JSON.parse(getAnalysis(cached.id, req.user.id).results_json) } catch {}
        res.writeHead(200, SSE_HEADERS)
        res.write(`data: ${JSON.stringify({ stage: "done", cached: true, result: results })}\n\n`)
        return res.end()
    }

    let upstream
    try {
        upstream = await fetch(`${req.app.locals.engineUrl}/analyse-stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                resume_json,
                job_description,
                provider: engineProvider,
                use_critic,
                local_endpoint,
                api_key: apiKey,
            }),
        })
    } catch {
        return res.status(502).json({ error: "The analysis engine is unreachable." })
    }

    if (!upstream.ok || !upstream.body) {
        return res.status(502).json({ error: "The analysis engine could not start the stream." })
    }

    // Headers must go out before the first chunk, and buffering must be off at
    // every hop or the whole point is lost.
    res.writeHead(200, SSE_HEADERS)
    res.flushHeaders?.()

    // a closed tab or a refresh stops the writes, not the analysis: it's read to
    // the end and saved, so the next request for it is a cache hit
    let closed = false
    res.on("close", () => { closed = true })
    const send = event => { if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`) }

    const decoder = new TextDecoder()
    let buffer = ""
    try {
        for await (const chunk of upstream.body) {
            buffer += decoder.decode(chunk, { stream: true })
            const parsed = parseSSEBuffer(buffer)
            buffer = parsed.rest
            for (const event of parsed.events) {
                if (event.stage !== "done") {
                    send(event)
                    continue
                }
                const results = event.result || {}
                results.parsed_resume = resume_json
                results.job_description = job_description || ""
                saveAnalysis({
                    userId: req.user.id, resumeId, results,
                    jobDescription: job_description, provider, hash,
                })
                send({ ...event, result: results })
            }
        }
    } catch (err) {
        send({ stage: "error", error: "The analysis stream was interrupted." })
    } finally {
        if (!closed) res.end()
    }
})

router.post("/run", requireAuth, llmLimiter, (req, res) => {
    const { job_description, provider, use_critic, local_endpoint, resume_id } = req.body
    const resumeId = parseInt(resume_id)
    const resume = resumeId ? getResume(resumeId, req.user.id) : null
    if (!resume) {
        return res.status(404).json({ error: "Resume not found." })
    }
    // the parse the server stored, not a copy the client sends back
    const resume_json = storedParse(resume) || req.body.resume_json
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
    const payload = {
        resume_id: resumeId, user_id: req.user.id, resume_json, file_key: fileKey(resume),
        job_description, provider, use_critic, local_endpoint,
    }
    const db = getDb()

    const hash = contentHash({ fileKey: payload.file_key, jobDescription: job_description, provider, useCritic: use_critic, localEndpoint: local_endpoint })
    const cached = cachedAnalysis(req.user.id, hash)
    if (cached) {
        const job = db.prepare(
            "INSERT INTO analysis_jobs (resume_id, user_id, request_json, status, analysis_id, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, datetime('now'), datetime('now'))"
        ).run(resumeId, req.user.id, JSON.stringify(payload), cached.id)
        return res.status(202).json({ job_id: job.lastInsertRowid, status: "queued" })
    }

    const row = db.prepare(
        "INSERT INTO analysis_jobs (resume_id, user_id, request_json, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', datetime('now'), datetime('now'))"
    ).run(resumeId, req.user.id, JSON.stringify(payload))
    run(req.app.locals.engineUrl, row.lastInsertRowid, payload)
    res.status(202).json({ job_id: row.lastInsertRowid, status: "queued" })
})

// the job fit on its own, for attempts that skip analyse(). the jd read is cached
// engine-side, so this is free when the same jd was analysed before
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
            jd_keywords: data.jd_keywords || [],
            missing_keywords: data.missing_keywords || [],
            strong_matches: data.strong_matches || [],
            keyword_frequencies: data.keyword_frequencies || {},
            match_pct: typeof data.match_pct === "number" ? data.match_pct : null,
            tailoring_tips: data.tailoring_tips || [],
            company: data.company || "",
        }
    } catch {
        return {}
    }
}

// never touches analyse() 
router.post("/quick-cover-letter", requireAuth, llmLimiter, async (req, res) => {
    const { job_description, provider, local_endpoint, resume_id, company } = req.body
    const resumeId = parseInt(resume_id)
    const resume = resumeId ? getResume(resumeId, req.user.id) : null
    if (!resume) {
        return res.status(404).json({ error: "Resume not found." })
    }
    const resume_json = storedParse(resume) || req.body.resume_json
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

        // only what's derivable without analyse(). same shape as a real one so the sidebar works
        const stored = {
            contact: resume_json?.contact || {},
            sections: resume_json?.sections || {},
            parsed_resume: resume_json,
            job_description: job_description || "",
            attempt_type: "cover_letter_only",
            model: data.model || "",
            ...gap,
        }
        const analysisId = saveAnalysis({
            userId: req.user.id, resumeId, results: stored, jobDescription: job_description,
            provider, attemptType: "cover_letter_only",
        })
        // company off the jd beats the client
        saveRev({
            analysisId, ownerId: req.user.id, type: "cover_letter",
            content: data.cover_letter_text || "", source: "ai", authorId: req.user.id,
            company: gap.company || company,
        })
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
            out.keyword_frequencies = {}
            out.match_pct = null
            out.strong_matches = []
            out.tailoring_tips = []
            out.company = ""
        }
        // only a resume_analysis hash feedscache, leave the other alone
        const resume = getResume(row.resume_id, req.user.id)
        const hash = row.attempt_type === "cover_letter_only" || !resume ? row.content_hash
            : contentHash({ fileKey: fileKey(resume), jobDescription: jd, provider, useCritic: false, localEndpoint: local_endpoint })
        updateResults(analysisId, out, { jobDescription: jd, hash })
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

// a restart kills the run() of every job that was queued or running. recent ones
// start again from their stored request, older ones fail so a poller stops waiting
export function recoverJobs(engineUrl) {
    const db = getDb()
    db.prepare(`
        UPDATE analysis_jobs SET status = 'failed', updated_at = datetime('now'),
            error = 'The server restarted during this analysis. Please run it again.'
        WHERE status IN ('queued', 'running') AND updated_at < datetime('now', '-30 minutes')
    `).run()
    const pending = db.prepare("SELECT id, request_json FROM analysis_jobs WHERE status IN ('queued', 'running')").all()
    for (const job of pending) {
        let payload = null
        try { payload = JSON.parse(job.request_json) } catch {}
        if (payload) {
            run(engineUrl, job.id, payload)
        } else {
            db.prepare("UPDATE analysis_jobs SET status = 'failed', error = 'The stored request could not be read.' WHERE id = ?").run(job.id)
        }
    }
    return pending.length
}

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
    // summary columns only, the results blobs stay on disk
    const rows = db.prepare(
        "SELECT id, resume_id, score_total, provider, model, attempt_type, company, match_pct, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id)

    res.json(rows.map(r => ({
        id: r.id,
        resume_id: r.resume_id,
        score: r.score_total,
        provider: r.provider,
        model: r.model,
        attempt_type: r.attempt_type || "resume_analysis",
        company: r.company || "",
        match_pct: r.match_pct,
        created_at: r.created_at,
    })))
})

router.get("/insights/overview", requireAuth, (req, res) => {
    const db = getDb()
    // insights wants the newest last so resort ascending outside
    const rows = db.prepare(`
        SELECT * FROM (
            SELECT id, resume_id, score_json, timing_json, score_total, provider, model, created_at
            FROM analyses WHERE user_id = ? AND attempt_type != 'cover_letter_only' ORDER BY created_at DESC LIMIT 50
        ) ORDER BY created_at ASC
    `).all(req.user.id)
    const analyses = rows.map(row => {
        let score = {}, timing = {}
        try { score = JSON.parse(row.score_json || "{}") } catch {}
        try { timing = JSON.parse(row.timing_json || "{}") } catch {}
        return {
            id: row.id,
            resume_id: row.resume_id,
            score: score.total !== undefined ? score : { total: row.score_total },
            timing,
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
    const keys = ["total", "quantification", "action_verbs", "structure"]
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
