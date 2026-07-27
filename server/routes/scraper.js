import { Router } from "express"
import fetch from "node-fetch"
import crypto from "crypto"
import { requireAuth } from "../middleware/auth.js"
import { getDb } from "../db.js"
import { getAnalysis } from "../access.js"
import { fetchEngine } from "../engineClient.js"
import { resolveProvider, ProviderError } from "../userKeys.js"
import { llmLimiter } from "../middleware/rateLimit.js"

const router = Router()
const PROVIDER_CHOICES = new Set(["default", "gemini", "claude", "chatgpt", "local"])
const COMPARE_CACHE_TTL_MINUTES = parseInt(process.env.ANALYSIS_CACHE_TTL_MINUTES || "60", 10)

// same inputs = same prompt, replay the last result
function compareHash(resume, jd, provider, endpoint) {
    return crypto.createHash("sha256").update(`${provider || ""}|${endpoint || ""}|${resume || ""}|${jd || ""}`).digest("hex")
}

router.post("/jd", requireAuth, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const resp = await fetch(`${engineUrl}/scrape-jd`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: req.body.url }),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = await resp.json()
        const text = String(data.text || "")
        let host = ""
        try { host = new URL(req.body.url).hostname } catch {}
        const row = getDb().prepare(
            "INSERT INTO job_descriptions (user_id, source_url, source_name, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, String(req.body.url || ""), host, text)
        res.json({ ...data, job_id: row.lastInsertRowid })
    } catch (err) {
        res.status(500).json({ error: "Scrape failed. Please try again." })
    }
})

router.post("/jobs", requireAuth, (req, res) => {
    const content = String(req.body.content || "").trim()
    if (!content) return res.status(400).json({ error: "Job description content is required." })
    const row = getDb().prepare(
        "INSERT INTO job_descriptions (user_id, source_url, source_name, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(req.user.id, String(req.body.source_url || ""), String(req.body.source_name || "Manual entry"), content)
    res.status(201).json({ id: row.lastInsertRowid, content })
})

router.get("/jobs", requireAuth, (req, res) => {
    const rows = getDb().prepare(
        "SELECT id, source_url, source_name, content, created_at FROM job_descriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id)
    res.json(rows)
})

// Number is NaN not a throw, and that NaN reaches a bind call. isFinite closes it
function toIdOrNull(raw) {
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
}

router.post("/linkedin", requireAuth, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        const resp = await fetch(`${engineUrl}/scrape-linkedin`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: req.body.url }),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = await resp.json()
        const analysisId = toIdOrNull(req.body.analysis_id)
        if (req.body.analysis_id && (!analysisId || !getAnalysis(analysisId, req.user.id))) {
            return res.status(404).json({ error: "Analysis not found." })
        }
        const jobId = toIdOrNull(req.body.job_id)
        if (req.body.job_id) {
            const job = getDb().prepare("SELECT id FROM job_descriptions WHERE id = ? AND user_id = ?").get(jobId, req.user.id)
            if (!job) return res.status(404).json({ error: "Job description not found." })
        }
        const row = getDb().prepare(
            "INSERT INTO job_matches (user_id, job_description_id, analysis_id, result_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, jobId, analysisId, JSON.stringify(data))
        res.json({ ...data, match_id: row.lastInsertRowid })
    } catch (err) {
        res.status(500).json({ error: "LinkedIn scrape failed. Please try again." })
    }
})

router.post("/compare", requireAuth, llmLimiter, async (req, res) => {
    const provider = req.body.provider
    if (!PROVIDER_CHOICES.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        return res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
    }
    const analysisId = toIdOrNull(req.body.analysis_id)
    if (req.body.analysis_id && (!analysisId || !getAnalysis(analysisId, req.user.id))) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    const jobId = toIdOrNull(req.body.job_id)
    if (req.body.job_id) {
        const job = getDb().prepare("SELECT id FROM job_descriptions WHERE id = ? AND user_id = ?").get(jobId, req.user.id)
        if (!job) return res.status(404).json({ error: "Job description not found." })
    }

    const resume = req.body.resume_text || ""
    const jd = req.body.jd_text || ""
    const endpoint = req.body.local_endpoint || ""
    const hash = compareHash(resume, jd, provider, endpoint)
    const db = getDb()

    if (!req.body.force_refresh && COMPARE_CACHE_TTL_MINUTES > 0) {
        const cached = db.prepare(
            `SELECT result_json FROM job_matches WHERE user_id = ? AND content_hash = ? AND content_hash != '' AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 1`
        ).get(req.user.id, hash, `-${COMPARE_CACHE_TTL_MINUTES} minutes`)
        if (cached) {
            let data = {}
            try { data = JSON.parse(cached.result_json) } catch {}
            return res.json({ ...data, cached: true })
        }
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
        const resp = await fetchEngine(`${engineUrl}/compare-resume-jd`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                resume_text: resume,
                jd_text: jd,
                provider: engineProvider,
                local_endpoint: endpoint,
                api_key: apiKey,
            }),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = await resp.json()
        const row = db.prepare(
            "INSERT INTO job_matches (user_id, job_description_id, analysis_id, result_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
        ).run(req.user.id, jobId, analysisId, JSON.stringify(data), hash)
        res.json({ ...data, match_id: row.lastInsertRowid })
    } catch (err) {
        res.status(500).json({ error: "Comparison failed. Please try again." })
    }
})

export default router
