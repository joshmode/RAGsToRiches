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

export function requireAuth(req, res, next) {
    const header = req.headers.authorization
    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Authentication required" })
    }

    const token = header.split(" ")[1]
    try {
        const decoded = jwt.verify(token, JWT_SECRET)
        // guests are purged well before their 7-day token expires 
        if (decoded.is_guest && !getDb().prepare("SELECT 1 FROM users WHERE id = ?").get(decoded.id)) {
            return res.status(401).json({ error: "Invalid or expired token" })
        }
        req.user = decoded
        next()
    } catch {
        return res.status(401).json({ error: "Invalid or expired token" })
    }
}

export function generateToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" })
}

export function requireRole(role) {
    return (req, res, next) => {
        if (req.user?.role !== role) {
            return res.status(403).json({ error: "You do not have permission to perform this action." })
        }
        next()
    }
}

export function optionalAuth(req, _res, next) {
    const header = req.headers.authorization
    if (header && header.startsWith("Bearer ")) {
        try {
            req.user = jwt.verify(header.split(" ")[1], JWT_SECRET)
        } catch {
            req.user = null
        }
    }
    next()
}
