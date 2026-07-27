import { Router } from "express"
import fetch from "node-fetch"
import { requireAuth } from "../middleware/auth.js"
import { BYOK_PROVIDERS, saveKey, deleteKey, hasKey } from "../userKeys.js"

const router = Router()

// their own byok keys plus the globals
router.get("/env-status", requireAuth, async (req, res) => {
    const status = {}
    for (const provider of BYOK_PROVIDERS) {
        status[provider] = hasKey(req.user.id, provider)
    }
    status.localAllowed = process.env.ALLOW_LOCAL_PROVIDER === "true"

    const engineUrl = req.app.locals.engineUrl
    try {
        const engine = await (await fetch(`${engineUrl}/env-status`)).json()
        status.default = !!engine.openrouter
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

router.get("/feedback-status", async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        res.json(await (await fetch(`${engineUrl}/feedback-status`)).json())
    } catch (err) {
        res.json({ silenced: false })
    }
})

// writes global engine state unlike the GETs above so it needs auth
router.post("/silence-feedback", requireAuth, async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        await fetch(`${engineUrl}/silence-feedback`, { method: "POST" })
        res.json({ ok: true })
    } catch {
        res.json({ ok: false })
    }
})

router.get("/forms-url", async (req, res) => {
    const engineUrl = req.app.locals.engineUrl
    try {
        res.json(await (await fetch(`${engineUrl}/forms-url`)).json())
    } catch {
        res.json({ url: "https://forms.gle/YOUR_FORM_ID_HERE" })
    }
})

export default router
