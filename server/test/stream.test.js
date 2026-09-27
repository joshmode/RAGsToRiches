// The streamed analysis is saved like any other, and a restart doesn't strand jobs.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { signUp, startApp, startEngine } from "./helpers.js"
import { parseSSEBuffer } from "../sse.js"

const PARSED = { raw_text: "x", contact: {}, sections: { EXPERIENCE: ["- Built it"] }, warnings: [], ocr_used: false }
const RESULT = { score: { total: 64 }, rewrites: { EXPERIENCE: [] }, sections: PARSED.sections, model: "stub-model" }

let engine, app, alice
let slow = false

function frame(event) {
    return `data: ${JSON.stringify(event)}\n\n`
}

before(async () => {
    engine = await startEngine({
        "/parse": () => [200, PARSED],
        "/analyse": () => [200, RESULT],
        "/analyse-stream": async (body, res) => {
            res.writeHead(200, { "Content-Type": "text/event-stream" })
            res.write(frame({ stage: "started" }))
            res.write(frame({ stage: "chunk", completed: 1, total: 1, rewrites: [{ id: "a", original: "x" }] }))
            if (slow) await new Promise(resolve => setTimeout(resolve, 300))
            if (body.job_description === "boom") {
                res.end(frame({ stage: "error", error: "Analysis failed. Please try again." }))
                return
            }
            res.end(frame({ stage: "done", result: RESULT }))
        },
    })
    app = await startApp(engine.url)
    alice = await signUp(app.base, "alice")
})

after(async () => {
    await app.close()
    await engine.close()
})

async function upload(client, bytes) {
    const data = new FormData()
    data.append("file", new Blob([bytes]), "resume.pdf")
    return (await client.post("/analysis/upload", data)).data.resume_id
}

async function stream(client, body, { signal } = {}) {
    const res = await client.post("/analysis/stream", body, { raw: true, headers: {}, signal })
    const { events } = parseSSEBuffer(await res.text())
    return events
}

const streamCalls = () => engine.calls.filter(call => call.path === "/analyse-stream").length

describe("the streamed analysis", () => {
    test("forwards progress and saves the result", async () => {
        const resumeId = await upload(alice, "%PDF stream one")
        const events = await stream(alice, { resume_id: resumeId, job_description: "Go", provider: "demo" })
        assert.deepEqual(events.map(e => e.stage), ["started", "chunk", "done"])
        const done = events.at(-1)
        assert.ok(done.result.analysis_id)
        assert.equal(done.result.resume_id, resumeId)
        const history = (await alice.get("/analysis/history")).data
        assert.ok(history.some(row => row.id === done.result.analysis_id && row.model === "stub-model"))
    })

    test("answers the same inputs from the cache", async () => {
        const resumeId = await upload(alice, "%PDF stream two")
        const body = { resume_id: resumeId, job_description: "Rust", provider: "demo" }
        const before = streamCalls()
        const first = await stream(alice, body)
        const second = await stream(alice, body)
        assert.equal(streamCalls() - before, 1)
        assert.equal(second.length, 1)
        assert.equal(second[0].cached, true)
        assert.equal(second[0].result.analysis_id, first.at(-1).result.analysis_id)
    })

    test("still saves the result when the browser goes away", async () => {
        slow = true
        const resumeId = await upload(alice, "%PDF stream three")
        const controller = new AbortController()
        const res = await fetch(`${app.base}/api/analysis/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: alice.cookieHeader() },
            body: JSON.stringify({ resume_id: resumeId, job_description: "Zig", provider: "demo" }),
            signal: controller.signal,
        })
        const reader = res.body.getReader()
        await reader.read()  // the first event arrived, then the tab closed
        controller.abort()
        await new Promise(resolve => setTimeout(resolve, 600))
        slow = false

        const again = await stream(alice, { resume_id: resumeId, job_description: "Zig", provider: "demo" })
        assert.equal(again[0].cached, true)
    })

    test("passes an engine failure through and saves nothing", async () => {
        const resumeId = await upload(alice, "%PDF stream four")
        const before = (await alice.get("/analysis/history")).data.length
        const events = await stream(alice, { resume_id: resumeId, job_description: "boom", provider: "demo" })
        assert.equal(events.at(-1).stage, "error")
        assert.equal((await alice.get("/analysis/history")).data.length, before)
    })
})

describe("after a restart", () => {
    test("recent jobs run again and old ones fail", async () => {
        const { getDb } = await import("../db.js")
        const { recoverJobs } = await import("../routes/analysis.js")
        const db = getDb()
        const resumeId = await upload(alice, "%PDF restart")
        const payload = { resume_id: resumeId, user_id: alice.user.id, resume_json: PARSED, job_description: "", provider: "demo", use_critic: false, local_endpoint: "" }
        const insert = db.prepare(
            "INSERT INTO analysis_jobs (resume_id, user_id, request_json, status, created_at, updated_at) VALUES (?, ?, ?, 'running', datetime('now', ?), datetime('now', ?))"
        )
        const recent = insert.run(resumeId, alice.user.id, JSON.stringify(payload), "-1 minutes", "-1 minutes").lastInsertRowid
        const stale = insert.run(resumeId, alice.user.id, JSON.stringify(payload), "-2 hours", "-2 hours").lastInsertRowid

        assert.equal(recoverJobs(app.app.locals.engineUrl), 1)
        let status
        for (let i = 0; i < 50 && status !== "completed"; i++) {
            status = (await alice.get(`/analysis/jobs/${recent}`)).data.status
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(status, "completed")
        const old = (await alice.get(`/analysis/jobs/${stale}`)).data
        assert.equal(old.status, "failed")
        assert.match(old.error, /restarted/)
    })
})
