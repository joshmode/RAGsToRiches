import { Router } from "express"
import bcrypt from "bcrypt"
import crypto from "crypto"
import { deleteUser, getDb, sweepGuests } from "../db.js"
import { clearSessionCookie, requireAuth, sessionUser, setSessionCookie } from "../middleware/auth.js"
import { guestLimiter } from "../middleware/rateLimit.js"

const router = Router()

router.post("/register", async (req, res) => {
    const { username, password, display_name, role, email } = req.body


    if (typeof username !== "string" || typeof password !== "string" || typeof display_name !== "string" ||
        !username.trim() || !password.trim() || !display_name.trim()) {
        return res.status(400).json({ error: "Display name, username, and password are required." })
    }
    if (role !== undefined && typeof role !== "string") {
        return res.status(400).json({ error: "Role must be candidate or mentor." })
    }
    if (email !== undefined && typeof email !== "string") {
        return res.status(400).json({ error: "Invalid email." })
    }
    if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." })
    }

    const db = getDb()
    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim().toLowerCase())
    if (existing) {
        return res.status(409).json({ error: "Username already taken." })
    }

    const r = (role || "candidate").toLowerCase()
    if (!["candidate", "mentor"].includes(r)) {
        return res.status(400).json({ error: "Role must be candidate or mentor." })
    }
    if (r === "mentor" && process.env.ALLOW_MENTOR_REGISTRATION !== "true") {
        return res.status(403).json({ error: "Mentor registration is not currently available." })
    }

    const hash = await bcrypt.hash(password, 12)
    const row = db.prepare(
        "INSERT INTO users (username, password_hash, display_name, role, email, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(username.trim().toLowerCase(), hash, display_name.trim(), r, (email || "").trim())

    const user = {
        id: row.lastInsertRowid,
        username: username.trim().toLowerCase(),
        display_name: display_name.trim(),
        role: r,
        is_guest: false,
    }

    setSessionCookie(req, res, user)
    res.status(201).json({ user })
})

router.post("/login", async (req, res) => {
    const { username, password } = req.body

    if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password.trim()) {
        return res.status(400).json({ error: "Username and password are required." })
    }

    const db = getDb()
    const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim().toLowerCase())
    if (!row) {
        return res.status(401).json({ error: "Invalid username or password." })
    }

    const valid = await bcrypt.compare(password, row.password_hash)
    if (!valid) {
        return res.status(401).json({ error: "Invalid username or password." })
    }

    const user = {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        is_guest: !!row.is_guest,
    }

    setSessionCookie(req, res, user)
    res.json({ user })
})

// a real but throwaway account so every per-user feature works 
router.post("/guest", guestLimiter, async (req, res) => {
    const db = getDb()
    sweepGuests(db)

    let username = ""
    for (let i = 0; i < 5 && !username; i++) {
        const cand = `guest_${crypto.randomBytes(6).toString("hex")}`
        if (!db.prepare("SELECT id FROM users WHERE username = ?").get(cand)) {
            username = cand
        }
    }
    if (!username) {
        return res.status(500).json({ error: "Could not start a guest session. Please try again." })
    }

    const hash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12)
    const row = db.prepare(
        "INSERT INTO users (username, password_hash, display_name, role, email, is_guest, created_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))"
    ).run(username, hash, "Guest", "candidate", "")

    const user = {
        id: row.lastInsertRowid,
        username,
        display_name: "Guest",
        role: "candidate",
        is_guest: true,
    }

    setSessionCookie(req, res, user)
    res.status(201).json({ user })
})

// the client can't read its own session cookie, so this is how it learns who it
// is. nobody signed in is an answer, not an error
router.get("/me", (req, res) => {
    const user = sessionUser(req)
    if (!user) return res.json({ user: null })
    const { id, username, display_name, role, is_guest } = user
    res.json({ user: { id, username, display_name, role, is_guest: !!is_guest } })
})

router.post("/logout", (req, res) => {
    clearSessionCookie(req, res)
    res.json({ ok: true })
})

// everything the account owns goes with it. a guest has no password to confirm
router.delete("/account", requireAuth, async (req, res) => {
    const db = getDb()
    const row = db.prepare("SELECT id, password_hash, is_guest FROM users WHERE id = ?").get(req.user.id)
    if (!row) return res.status(404).json({ error: "Account not found." })
    if (!row.is_guest) {
        const password = req.body?.password
        if (typeof password !== "string" || !(await bcrypt.compare(password, row.password_hash))) {
            return res.status(403).json({ error: "That password isn't right." })
        }
    }
    deleteUser(db, row.id)
    clearSessionCookie(req, res)
    res.json({ ok: true })
})

export default router
