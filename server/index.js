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
import { getDb } from "./db.js"
import { generalLimiter, authLimiter } from "./middleware/rateLimit.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.resolve(__dirname, "..", ".env") })

const app = express()
const PORT = process.env.API_PORT || 3000
const ENGINE_URL = process.env.ENGINE_URL || "http://localhost:5001"

// express 4 won't route a rejected async handler to the error middleware, so one missed and hbangs everything
process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err)
})

getDb()

// correct client ips behind a reverse proxy
app.set("trust proxy", 1)

app.use(helmet({
    contentSecurityPolicy: false, // same-origin spa bundle, the default csp blocks it
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
app.use(express.json({ limit: "50mb" }))

// express.json() throws SyntaxError 
app.use((err, _req, res, next) => {
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

const server = app.listen(PORT, () => {
    console.log(`ragstoriches api listening on :${PORT}`)
    console.log(`engine url: ${ENGINE_URL}`)
})

function shutdown(signal) {
    console.log(`${signal} received, shutting down gracefully`)
    server.close(() => {
        console.log("HTTP server closed")
        process.exit(0)
    })
    setTimeout(() => process.exit(1), 10000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

export default app
