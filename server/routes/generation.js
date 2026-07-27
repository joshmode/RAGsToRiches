import { Router } from "express"
import fetch from "node-fetch"
import { requireAuth } from "../middleware/auth.js"
import { getDb } from "../db.js"
import { getAnalysis, canAccess } from "../access.js"
import {
    saveRev, effective, revs,
    getCompany, sugKey, TYPES,
} from "../documents.js"
import { fetchEngine } from "../engineClient.js"
import { llmLimiter } from "../middleware/rateLimit.js"
import { resolveProvider, ProviderError } from "../userKeys.js"

const router = Router()
const PROVIDER_CHOICES = new Set(["default", "gemini", "claude", "chatgpt", "local"])

// prevent client from using own api
function buildPayload(req, res, extra) {
    const provider = req.body.provider
    if (!PROVIDER_CHOICES.has(provider)) {
        res.status(400).json({ error: "Unknown provider." })
        return null
    }
    if (provider === "local" && process.env.ALLOW_LOCAL_PROVIDER !== "true") {
        res.status(403).json({ error: "Local model endpoints are disabled for this deployment." })
        return null
    }
    try {
        const { engineProvider, apiKey } = resolveProvider(req.user.id, provider)
        return {
            resume_json: req.body.resume_json,
            job_description: req.body.job_description || "",
            provider: engineProvider,
            local_endpoint: req.body.local_endpoint || "",
            api_key: apiKey,
            ...extra,
        }
    } catch (err) {
        if (err instanceof ProviderError) {
            res.status(err.status).json({ error: err.message })
            return null
        }
        throw err
    }
}

// accepted mentor rewrites beat the llm's own for that bullet
function bulletOverrides(analysisId, candidateId) {
    if (!analysisId) return {}
    const rows = getDb().prepare(`
        SELECT suggestion_key, suggested_text FROM mentor_feedback
        WHERE analysis_id = ? AND candidate_id = ? AND feedback_type = 'edit'
          AND status = 'accepted' AND suggestion_key != ''
        ORDER BY updated_at ASC, id ASC
    `).all(analysisId, candidateId)
    // last accepted wins thats why the ORDER BY 
    return Object.fromEntries(rows.map(r => [r.suggestion_key, r.suggested_text]))
}

// an accepted section edit wins outright the engine skips per-bullet rewrites there
function sectionOverrides(analysisId, candidateId) {
    if (!analysisId) return {}
    const rows = getDb().prepare(`
        SELECT section, suggested_text FROM mentor_feedback
        WHERE analysis_id = ? AND candidate_id = ? AND feedback_type = 'section_edit'
          AND status = 'accepted' AND section != ''
        ORDER BY updated_at ASC, id ASC
    `).all(analysisId, candidateId)
    // last one wins
    return Object.fromEntries(rows.map(r => [r.section, r.suggested_text]))
}

router.post("/cv", requireAuth, llmLimiter, async (req, res) => {
    const analysisId = req.body.analysis_id ? parseInt(req.body.analysis_id) : null
    if (req.body.analysis_id && (!analysisId || !getAnalysis(analysisId, req.user.id))) {
        return res.status(404).json({ error: "Analysis not found." })
    }

    // ask the effective doc not the raw feedback row 
    const current = effective(analysisId, req.user.id, "cv")
    if (current?.source === "mentor") return res.json({ cv_text: current.content })

    const payload = buildPayload(req, res, {
        acc_map: req.body.acc_map || {},
        rewrite_suggestions: req.body.rewrite_suggestions || null,
        rewrite_decisions: req.body.rewrite_decisions || null,
        mentor_overrides: bulletOverrides(analysisId, req.user.id),
        section_overrides: sectionOverrides(analysisId, req.user.id),
    })
    if (!payload) return

    const engineUrl = req.app.locals.engineUrl
    try {
        const resp = await fetchEngine(`${engineUrl}/gen-cv`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = await resp.json()
        saveRev({
            analysisId, ownerId: req.user.id, type: "cv",
            content: data.cv_text || "", source: "ai", authorId: req.user.id,
        })
        res.json(data)
    } catch (err) {
        res.status(500).json({ error: "CV generation failed. Please try again." })
    }
})

router.post("/cover-letter", requireAuth, llmLimiter, async (req, res) => {
    const analysisId = req.body.analysis_id ? parseInt(req.body.analysis_id) : null
    if (req.body.analysis_id && (!analysisId || !getAnalysis(analysisId, req.user.id))) {
        return res.status(404).json({ error: "Analysis not found." })
    }

    // same rule as /cv
    const current = effective(analysisId, req.user.id, "cover_letter")
    if (current?.source === "mentor") return res.json({ cover_letter_text: current.content })

    const payload = buildPayload(req, res, {})
    if (!payload) return

    const engineUrl = req.app.locals.engineUrl
    try {
        const resp = await fetchEngine(`${engineUrl}/gen-cover-letter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = await resp.json()
        saveRev({
            analysisId, ownerId: req.user.id, type: "cover_letter",
            content: data.cover_letter_text || "", source: "ai", authorId: req.user.id,
            company: req.body.company,
        })
        res.json(data)
    } catch (err) {
        res.status(500).json({ error: "Cover letter generation failed. Please try again." })
    }
})

async function exportDoc(req, res, path, type) {
    const engineUrl = req.app.locals.engineUrl
    try {
        const resp = await fetch(`${engineUrl}/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: req.body.text || "" }),
        })
        if (!resp.ok) return res.status(resp.status).json(await resp.json())
        const data = Buffer.from(await resp.arrayBuffer())
        res.setHeader("Content-Type", type)
        const filename = String(req.body.filename || "ragstoriches_document").replace(/[^a-zA-Z0-9._-]/g, "_")
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
        res.send(data)
    } catch (err) {
        res.status(500).json({ error: `Document export failed: ${err.message}` })
    }
}

// saved is honest and a refresh gets the edited text back
router.post("/save", requireAuth, (req, res) => {
    const analysisId = parseInt(req.body.analysis_id)
    const type = req.body.document_type
    if (!["cv", "cover_letter"].includes(type)) {
        return res.status(400).json({ error: "Unknown document type." })
    }
    if (!analysisId || !getAnalysis(analysisId, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    // the editor autosaves on re-open too
    const content = String(req.body.content ?? "")
    const current = effective(analysisId, req.user.id, type)
    if (current && current.content === content) return res.json({ ok: true, unchanged: true })

    // a candidate edit is a real version
    saveRev({
        analysisId, ownerId: req.user.id, type,
        content, source: "user", authorId: req.user.id,
        company: req.body.company,
    })
    res.json({ ok: true })
})

// so switching tabs restores the last generated doc instead of forcing a regenerate
router.get("/latest", requireAuth, (req, res) => {
    const analysisId = parseInt(req.query.analysis_id)
    if (!analysisId || !getAnalysis(analysisId, req.user.id)) {
        return res.status(404).json({ error: "Analysis not found." })
    }
    // shared precedence rule
    const docs = {}
    for (const type of TYPES) {
        const rev = effective(analysisId, req.user.id, type)
        if (rev) {
            docs[type] = {
                content: rev.content, created_at: rev.created_at,
                source: rev.source, company: rev.company || "",
            }
        }
    }
    res.json(docs)
})

// one endpoint for both roles
router.get("/timeline", requireAuth, (req, res) => {
    const analysisId = parseInt(req.query.analysis_id)
    const type = req.query.document_type
    if (!TYPES.has(type)) {
        return res.status(400).json({ error: "Unknown document type." })
    }
    const analysis = analysisId ? canAccess(analysisId, req.user) : null
    if (!analysis) return res.status(404).json({ error: "Analysis not found." })

    const db = getDb()
    const ownerId = analysis.user_id
    const versions = revs(analysisId, ownerId, type)

    // oldest first so follows the order sent
    const feedback = db.prepare(`
        SELECT mf.id, mf.mentor_id, mf.original_text, mf.suggested_text, mf.comment,
               mf.status, mf.created_at, mf.updated_at, u.display_name AS mentor_name
        FROM mentor_feedback mf JOIN users u ON u.id = mf.mentor_id
        WHERE mf.analysis_id = ? AND mf.candidate_id = ? AND mf.suggestion_key = ?
        ORDER BY mf.created_at ASC, mf.id ASC
    `).all(analysisId, ownerId, sugKey(type, analysisId))

    // the doc's own thread plus the per-revision ones
    const keys = [sugKey(type, analysisId), ...feedback.map(f => `cover_letter_feedback:${f.id}`)]
    const marks = keys.map(() => "?").join(",")
    const discussion = db.prepare(`
        SELECT a.id, a.suggestion_key, a.comment, a.created_at, a.user_id,
               u.display_name AS author_name, u.role AS author_role
        FROM annotations a JOIN users u ON u.id = a.user_id
        WHERE a.analysis_id = ? AND a.suggestion_key IN (${marks})
        ORDER BY a.created_at ASC, a.id ASC
    `).all(analysisId, ...keys)

    res.json({
        analysis_id: analysisId,
        document_type: type,
        company: type === "cover_letter" ? getCompany(analysisId) : "",
        effective: effective(analysisId, ownerId, type),
        versions,
        feedback,
        discussion,
    })
})

router.post("/docx", requireAuth, (req, res) => exportDoc(req, res, "export-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
router.post("/pdf", requireAuth, (req, res) => exportDoc(req, res, "export-pdf", "application/pdf"))

export default router
