import jwt from "jsonwebtoken"
import dotenv from "dotenv"
import path from "path"
import { fileURLToPath } from "url"
import { getDb } from "../db.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") })

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "ragstoriches_dev_secret")

if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is required in production.")
}

// the session is an httpOnly cookie, so no script on the page can read it. it was
// a bearer token in localStorage, where any injected script could lift it
export const SESSION_COOKIE = "rtr_session"
const SESSION_DAYS = 7

function cookieOptions(req) {
    return { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/api" }
}

export function setSessionCookie(req, res, user) {
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` })
    // a guest's goes when the browser closes, an account's when the token expires
    res.cookie(SESSION_COOKIE, token, {
        ...cookieOptions(req),
        ...(user.is_guest ? {} : { maxAge: SESSION_DAYS * 24 * 3600 * 1000 }),
    })
}

export function clearSessionCookie(req, res) {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req))
}

function readCookie(req, name) {
    for (const part of (req.headers.cookie || "").split(";")) {
        const at = part.indexOf("=")
        if (at !== -1 && part.slice(0, at).trim() === name) {
            try { return decodeURIComponent(part.slice(at + 1).trim()) } catch { return "" }
        }
    }
    return ""
}

// the signed-in user behind a request, or null
export function sessionUser(req) {
    const token = readCookie(req, SESSION_COOKIE)
    if (!token) return null
    try {
        const decoded = jwt.verify(token, JWT_SECRET)
        // guests are purged well before their 7-day token expires, and anyone can
        // delete their account, so a valid signature isn't enough on its own
        return getDb().prepare("SELECT 1 FROM users WHERE id = ?").get(decoded.id) ? decoded : null
    } catch {
        return null
    }
}

export function requireAuth(req, res, next) {
    const user = sessionUser(req)
    if (!user) return res.status(401).json({ error: "Your session has ended. Please sign in again." })
    req.user = user
    next()
}

export function requireRole(role) {
    return (req, res, next) => {
        if (req.user?.role !== role) {
            return res.status(403).json({ error: "You do not have permission to perform this action." })
        }
        next()
    }
}
