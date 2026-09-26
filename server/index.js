import app from "./app.js"
import { getDb } from "./db.js"
import { recoverJobs } from "./routes/analysis.js"

const PORT = process.env.API_PORT || 3000

// express 4 won't route a rejected async handler to the error middleware, so one missed and hbangs everything
process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err)
})

getDb()
const resumed = recoverJobs(app.locals.engineUrl)
if (resumed) console.log(`resumed ${resumed} analysis job(s) interrupted by the last restart`)

const server = app.listen(PORT, () => {
    console.log(`ragstoriches api listening on :${PORT}`)
    console.log(`engine url: ${app.locals.engineUrl}`)
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
