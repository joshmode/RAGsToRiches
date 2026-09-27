// Anyone can delete their account and everything in it, and expired guests are
// swept on a timer instead of waiting for the next guest to sign up.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Client, seedAnalysis, signUp, startApp, startEngine } from "./helpers.js"

let engine, app

before(async () => {
    engine = await startEngine()
    app = await startApp(engine.url)
})

after(async () => {
    await app.close()
    await engine.close()
})

async function rowCount(table, where, ...args) {
    const { getDb } = await import("../db.js")
    return getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n
}

describe("deleting an account", () => {
    test("needs the password", async () => {
        const dana = await signUp(app.base, "dana")
        assert.equal((await dana.delete("/auth/account", { password: "wrong" })).status, 403)
        assert.equal((await dana.get("/auth/me")).data.user.username, "dana")
    })

    test("removes the user and everything they own", async () => {
        const erin = await signUp(app.base, "erin")
        const held = erin.cookieHeader()
        const { analysisId } = await seedAnalysis(erin.user)
        await erin.put(`/analysis/${analysisId}/decisions/k`, { decision: true })
        await erin.post("/generate/save", { analysis_id: analysisId, document_type: "cv", content: "# Erin" })

        assert.equal((await erin.delete("/auth/account", { password: "correct-horse" })).status, 200)

        assert.equal(await rowCount("users", "id = ?", erin.user.id), 0)
        assert.equal(await rowCount("resumes", "user_id = ?", erin.user.id), 0)
        assert.equal(await rowCount("analyses", "user_id = ?", erin.user.id), 0)
        assert.equal(await rowCount("rewrite_decisions", "analysis_id = ?", analysisId), 0)
        assert.equal(await rowCount("generated_documents", "analysis_id = ?", analysisId), 0)
        // the old session stops working, signed or not
        assert.equal((await erin.get("/analysis/history", { headers: { Cookie: held } })).status, 401)
    })

    test("a guest can leave without a password", async () => {
        const guest = new Client(app.base)
        await guest.post("/auth/guest")
        assert.equal((await guest.delete("/auth/account")).status, 200)
        assert.equal((await guest.get("/auth/me")).data.user, null)
    })

    test("a mentor leaving keeps what a candidate accepted", async () => {
        const mentor = await signUp(app.base, "mentor_gus", "mentor")
        const fay = await signUp(app.base, "fay")
        const { analysisId } = await seedAnalysis(fay.user)
        const session = await mentor.post("/mentor/session")
        await fay.post("/mentor/session/join", { code: session.data.code })
        await fay.post("/generate/save", { analysis_id: analysisId, document_type: "cv", content: "## EXPERIENCE\nold" })
        const sent = await mentor.post("/mentor/feedback", {
            candidate_id: fay.user.id, analysis_id: analysisId, suggestion_key: `preview:${analysisId}`,
            feedback_type: "edit", suggested_text: "## EXPERIENCE\nmentor's rewrite",
        })
        await fay.post(`/mentor/feedback/${sent.data.id}/status`, { status: "accepted" })

        assert.equal((await mentor.delete("/auth/account", { password: "correct-horse" })).status, 200)

        assert.equal(await rowCount("review_sessions", "mentor_id = ?", mentor.user.id), 0)
        assert.equal((await fay.get(`/generate/latest?analysis_id=${analysisId}`)).data.cv.content, "## EXPERIENCE\nmentor's rewrite")
    })
})

describe("guest expiry", () => {
    test("sweeps guests past their retention without a new sign-up", async () => {
        const { getDb, sweepGuests } = await import("../db.js")
        const guest = new Client(app.base)
        const res = await guest.post("/auth/guest")
        await seedAnalysis(res.data.user)
        getDb().prepare("UPDATE users SET created_at = datetime('now', '-2 days') WHERE id = ?").run(res.data.user.id)

        assert.ok(sweepGuests(getDb()) >= 1)
        assert.equal(await rowCount("users", "id = ?", res.data.user.id), 0)
        assert.equal(await rowCount("analyses", "user_id = ?", res.data.user.id), 0)
    })
})
