import express from "express"
import cors from "cors"
import helmet from "helmet"
import dotenv from "dotenv"
import path from "path"
import { fileURLToPath } from "url"

import authRoutes from "./routes/auth.js"
import analysisRoutes from "./routes/analysis.js"
import generationRoutes from "./routes/generation.js"
import mentorRoutes from "./routes/mentor.js"
import annotationRoutes from "./routes/annotations.js"
import scraperRoutes from "./routes/scraper.js"
import settingsRoutes from "./routes/settings.js"
import feedbackRoutes from "./routes/feedback.js"
import notificationRoutes from "./routes/notifications.js"
import { generalLimiter, authLimiter } from "./middleware/rateLimit.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.resolve(__dirname, "..", ".env") })

// the app without a listener, so the tests can drive it. index.js starts it
const app = express()
const ENGINE_URL = process.env.ENGINE_URL || "http://localhost:5001"

// correct client ips behind a reverse proxy
app.set("trust proxy", 1)

// the bundle is all same-origin files, so scripts come from here and nowhere else.
// fonts are google's, the pdf viewer runs a worker, and pdf.js may hand embedded
// fonts over as data: urls
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            imgSrc: ["'self'", "data:", "blob:"],
            workerSrc: ["'self'", "blob:"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            // plain http on localhost would otherwise be upgraded and fail
            upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
        },
    },
}))

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean)

app.use(cors({
    origin(origin, callback) {
        // no Origin header means same-origin 
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
        callback(new Error("Not allowed by CORS"))
    },
    credentials: true,
}))
// files come in through multer, json bodies are only ever text: a cv, a letter, a
// job description. 50mb was room for a base64 pdf the client no longer sends
app.use(express.json({ limit: "2mb" }))

// express.json() throws SyntaxError
app.use((err, _req, res, next) => {
    if (err?.type === "entity.too.large") {
        return res.status(413).json({ error: "That request is too large. Text fields are capped at 2 MB." })
    }
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
        return res.status(400).json({ error: "Malformed JSON in request body." })
    }
    next(err)
})

app.locals.engineUrl = ENGINE_URL

app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", engine: ENGINE_URL })
})

app.use("/api", generalLimiter)
app.use("/api/auth", authLimiter, authRoutes)
app.use("/api/generate", generationRoutes)
app.use("/api/analysis", analysisRoutes)
app.use("/api/mentor", mentorRoutes)
app.use("/api/annotations", annotationRoutes)
app.use("/api/scrape", scraperRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/feedback", feedbackRoutes)
app.use("/api/notifications", notificationRoutes)

// unmatched /api/* stays json, don't fall through to the spa
app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." })
})

const clientDist = path.resolve(__dirname, "..", "client", "dist")
app.use(express.static(clientDist))
// a hashed file an older build asked for, from a tab left open across a deploy. the
// page's html in its place fails as a module script, a 404 says what happened
app.use("/assets", (_req, res) => {
    res.status(404).end()
})
app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"))
})

// last resort, still json not a crash
app.use((err, _req, res, _next) => {
    if (err?.message === "Not allowed by CORS") {
        return res.status(403).json({ error: "This origin is not permitted to access the API." })
    }
    console.error(err)
    if (res.headersSent) return
    res.status(err?.status || 500).json({ error: "Internal server error." })
})

export default app
