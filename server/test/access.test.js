// Access control: the riskiest code in the server, and it had no tests.
// Run with: npm test (from server/)

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { seedAnalysis, signUp, startApp, startEngine } from "./helpers.js"

let engine, app, alice, bob, mentor, otherMentor, aliceAttempt

before(async () => {
    engine = await startEngine()
    app = await startApp(engine.url)
    alice = await signUp(app.base, "alice")
    bob = await signUp(app.base, "bob")
    mentor = await signUp(app.base, "mentor_mo", "mentor")
    otherMentor = await signUp(app.base, "mentor_max", "mentor")
    aliceAttempt = await seedAnalysis(alice.user)

    const session = await mentor.post("/mentor/session")
    await alice.post("/mentor/session/join", { code: session.data.code })
})

after(async () => {
    await app.close()
    await engine.close()
})

describe("another candidate's attempt", () => {
    test("can't be read", async () => {
        const { analysisId, resumeId } = aliceAttempt
        for (const path of [
            `/analysis/${analysisId}`,
            `/analysis/${analysisId}/decisions`,
            `/analysis/${analysisId}/revisions`,
            `/analysis/resumes/${resumeId}/file`,
            `/analysis/resumes/${resumeId}/history`,
            `/annotations/${analysisId}`,
            `/generate/latest?analysis_id=${analysisId}`,
            `/generate/timeline?analysis_id=${analysisId}&document_type=cv`,
        ]) {
            const res = await bob.get(path)
            assert.equal(res.status, 404, path)
        }
    })

    test("can't be written to", async () => {
        const { analysisId } = aliceAttempt
        assert.equal((await bob.post(`/analysis/${analysisId}/decisions`, { decisions: { x: true } })).status, 404)
        assert.equal((await bob.post("/annotations", { analysis_id: analysisId, suggestion_key: "x", comment: "hi" })).status, 404)
        assert.equal((await bob.post("/generate/save", { analysis_id: analysisId, document_type: "cv", content: "x" })).status, 404)
        assert.equal((await bob.post("/feedback", { analysis_id: analysisId, consent: true })).status, 404)
    })

    test("doesn't show up in history", async () => {
        const res = await bob.get("/analysis/history")
        assert.deepEqual(res.data, [])
    })
})

describe("the owner", () => {
    test("can read their own attempt", async () => {
        const res = await alice.get(`/analysis/${aliceAttempt.analysisId}`)
        assert.equal(res.status, 200)
        assert.equal(res.data.id, aliceAttempt.analysisId)
    })
})

describe("a mentor", () => {
    test("reads a candidate who joined their active session", async () => {
        assert.equal((await mentor.get(`/analysis/${aliceAttempt.analysisId}`)).status, 200)
        const history = await mentor.get(`/mentor/candidates/${alice.user.id}/history`)
        assert.equal(history.status, 200)
        assert.equal(history.data.analyses.length, 1)
    })

    test("can't read a candidate from someone else's session", async () => {
        assert.equal((await otherMentor.get(`/analysis/${aliceAttempt.analysisId}`)).status, 404)
        assert.equal((await otherMentor.get(`/mentor/candidates/${alice.user.id}/history`)).status, 404)
        assert.equal((await otherMentor.get(`/mentor/candidates/${alice.user.id}/analyses/${aliceAttempt.analysisId}`)).status, 404)
    })

    test("can't read a candidate who never joined", async () => {
        const bobAttempt = await seedAnalysis(bob.user)
        assert.equal((await mentor.get(`/analysis/${bobAttempt.analysisId}`)).status, 404)
        assert.equal((await mentor.get(`/mentor/candidates/${bob.user.id}/history`)).status, 404)
    })

    test("can't use candidate-only routes", async () => {
        assert.equal((await mentor.post("/mentor/session/join", { code: "ANYTHING" })).status, 403)
    })
})

describe("a candidate", () => {
    test("can't use mentor-only routes", async () => {
        assert.equal((await alice.get("/mentor/dashboard")).status, 403)
        assert.equal((await alice.post("/mentor/session")).status, 403)
        assert.equal((await alice.get(`/mentor/candidates/${bob.user.id}/history`)).status, 403)
    })
})

describe("without a session", () => {
    test("every data route needs one", async () => {
        const res = await fetch(`${app.base}/api/analysis/history`)
        assert.equal(res.status, 401)
    })
})

describe("closing a session", () => {
    test("ends the mentor's access to its candidates", async () => {
        const carol = await signUp(app.base, "carol")
        const attempt = await seedAnalysis(carol.user)
        const session = await mentor.post("/mentor/session")
        await carol.post("/mentor/session/join", { code: session.data.code })
        const reads = [
            `/analysis/${attempt.analysisId}`,
            `/mentor/candidates/${carol.user.id}/history`,
            `/mentor/candidates/${carol.user.id}/analyses/${attempt.analysisId}`,
            `/mentor/candidates/${carol.user.id}/analyses/${attempt.analysisId}/preview`,
            `/mentor/candidates/${carol.user.id}/cover-letters`,
        ]
        for (const path of reads) assert.equal((await mentor.get(path)).status, 200, path)

        await mentor.post(`/mentor/session/${session.data.code}/close`)

        for (const path of reads) assert.equal((await mentor.get(path)).status, 404, path)
        const dashboard = await mentor.get("/mentor/dashboard")
        assert.ok(!dashboard.data.candidates.some(c => c.id === carol.user.id))
        const report = await mentor.get("/mentor/report")
        assert.ok(!report.data.report.includes("@carol"))
    })
})
