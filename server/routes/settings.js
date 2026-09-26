import { Router } from "express"
import fetch from "node-fetch"
import { requireAuth } from "../middleware/auth.js"
import { BYOK_PROVIDERS, saveKey, deleteKey, hasKey, pooledProvider, demoAllowed } from "../userKeys.js"

const router = Router()

// their own byok keys plus the globals
router.get("/env-status", requireAuth, async (req, res) => {
    const status = {}
    for (const provider of BYOK_PROVIDERS) {
        status[provider] = hasKey(req.user.id, provider)
    }
    status.localAllowed = process.env.ALLOW_LOCAL_PROVIDER === "true"
    status.demo = demoAllowed()

    const engineUrl = req.app.locals.engineUrl
    try {
        const engine = await (await fetch(`${engineUrl}/env-status`)).json()
        status.default = process.env.DEMO_MODE === "true" || !!engine[pooledProvider()]
        status.linkedin = !!engine.linkedin
    } catch {
        status.default = false
        status.linkedin = false
    }
    res.json(status)
})

router.post("/api-key", requireAuth, (req, res) => {
    const provider = String(req.body.provider || "")
    const key = String(req.body.key || "").trim()

    if (!BYOK_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    if (!key) {
        return res.status(400).json({ error: "Key cannot be empty." })
    }
    if (/[\r\n]/.test(key)) {
        return res.status(400).json({ error: "Key contains invalid characters." })
    }

    try {
        saveKey(req.user.id, provider, key)
        res.json({ ok: true })
    } catch (err) {
        res.status(500).json({ error: "Failed to save key. Please try again." })
    }
})

router.delete("/api-key/:provider", requireAuth, (req, res) => {
    if (!BYOK_PROVIDERS.has(req.params.provider)) {
        return res.status(400).json({ error: "Unknown provider." })
    }
    deleteKey(req.user.id, req.params.provider)
    res.json({ ok: true })
})

// an optional external form beside the in-app rating. unset means no link
router.get("/feedback-form", (_req, res) => {
    res.json({ url: process.env.FEEDBACK_FORM_URL || "" })
})

export default router
