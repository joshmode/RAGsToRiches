// History lists read summary columns instead of parsing every results blob.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { signUp, startApp, startEngine } from "./helpers.js"

const PARSED = { raw_text: "x", contact: {}, sections: { EXPERIENCE: ["- Built it"] }, warnings: [], ocr_used: false }

let engine, app, alice

before(async () => {
    engine = await startEngine({
        "/parse": () => [200, PARSED],
        "/analyse": () => [200, {
            score: { total: 58, quantification: 20, action_verbs: 20, structure: 18, section_scores: {} },
            timing: { total_ms: 1200 },
            rewrites: {}, sections: PARSED.sections, model: "stub-model",
            jd_keywords: ["Python", "Go", "AWS", "Kafka"], missing_keywords: ["AWS", "Kafka"],
            match_pct: 50, company: "Harbor Labs",
        }],
    })
    app = await startApp(engine.url)
    alice = await signUp(app.base, "alice")
})

after(async () => {
    await app.close()
    await engine.close()
})

async function analyse(client) {
    const data = new FormData()
    data.append("file", new Blob(["%PDF-1.4 history"]), "resume.pdf")
    const upload = await client.post("/analysis/upload", data)
    const job = await client.post("/analysis/run", { resume_id: upload.data.resume_id, job_description: "Python Go AWS Kafka", provider: "demo" })
    for (let i = 0; i < 50; i++) {
        const res = await client.get(`/analysis/jobs/${job.data.job_id}`)
        if (res.data.status === "completed") return res.data.analysis_id
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error("job never finished")
}

describe("history", () => {
    test("lists the summary without the results blob", async () => {
        const id = await analyse(alice)
        const [row] = (await alice.get("/analysis/history")).data
        assert.equal(row.id, id)
        assert.equal(row.company, "Harbor Labs")
        assert.equal(row.match_pct, 50)
        assert.equal(row.model, "stub-model")
        assert.equal(row.score, 58)
        assert.equal(row.results_json, undefined)
    })

    test("the insights overview reads the stored score and timing", async () => {
        const { analyses } = (await alice.get("/analysis/insights/overview")).data
        assert.equal(analyses.at(-1).score.quantification, 20)
        assert.equal(analyses.at(-1).timing.total_ms, 1200)
    })

    test("an attempt from before the columns is backfilled once", async () => {
        const { getDb, backfillSummaries } = await import("../db.js")
        const db = getDb()
        const resume = db.prepare("INSERT INTO resumes (user_id, filename, created_at) VALUES (?, 'old.pdf', datetime('now'))").run(alice.user.id)
        // an old row: the model's guessed match of 90 beside keywords that cover a third
        const legacy = {
            score: { total: 70, base: 30 }, company: "Old Co", match_pct: 90,
            jd_keywords: ["Python", "Go", "Rust"], missing_keywords: ["Go", "Rust"],
        }
        const row = db.prepare(
            "INSERT INTO analyses (resume_id, user_id, results_json, score_total, created_at) VALUES (?, ?, ?, 70, datetime('now', '+1 minute'))"
        ).run(resume.lastInsertRowid, alice.user.id, JSON.stringify(legacy))
        backfillSummaries(db)
        const listed = (await alice.get("/analysis/history")).data.find(r => r.id === Number(row.lastInsertRowid))
        assert.equal(listed.company, "Old Co")
        assert.equal(listed.match_pct, 33)  // the coverage, not the guess
    })
})
