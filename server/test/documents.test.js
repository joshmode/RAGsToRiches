// Autosaves fold into one revision per sitting instead of one per pause in typing,
// and a document body can't be used to push megabytes through the api.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { seedAnalysis, signUp, startApp, startEngine } from "./helpers.js"

let engine, app, alice

before(async () => {
    engine = await startEngine()
    app = await startApp(engine.url)
    alice = await signUp(app.base, "alice")
})

after(async () => {
    await app.close()
    await engine.close()
})

const save = (analysisId, content) => alice.post("/generate/save", { analysis_id: analysisId, document_type: "cv", content })
const versions = async analysisId =>
    (await alice.get(`/generate/timeline?analysis_id=${analysisId}&document_type=cv`)).data.versions

describe("autosave", () => {
    test("a run of saves is one revision holding the latest text", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        for (const text of ["# CV", "# CV\n- one", "# CV\n- one\n- two"]) await save(analysisId, text)
        const saved = await versions(analysisId)
        assert.equal(saved.length, 1)
        assert.equal(saved[0].content, "# CV\n- one\n- two")
        assert.equal((await alice.get(`/generate/latest?analysis_id=${analysisId}`)).data.cv.content, "# CV\n- one\n- two")
    })

    test("another author's revision in between starts a new one", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        await save(analysisId, "first sitting")
        const { saveRev } = await import("../documents.js")
        saveRev({ analysisId, ownerId: alice.user.id, type: "cv", content: "regenerated", source: "ai", authorId: alice.user.id })
        await save(analysisId, "second sitting")
        assert.deepEqual((await versions(analysisId)).map(v => v.content), ["first sitting", "regenerated", "second sitting"])
    })

    test("coming back later starts a new one", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        await save(analysisId, "morning")
        const { getDb } = await import("../db.js")
        getDb().prepare("UPDATE generated_documents SET created_at = datetime('now', '-2 hours'), updated_at = datetime('now', '-2 hours') WHERE analysis_id = ?").run(analysisId)
        await save(analysisId, "afternoon")
        assert.equal((await versions(analysisId)).length, 2)
    })
})

describe("request size", () => {
    test("a body over 2 MB is turned away before it reaches a route", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        const res = await save(analysisId, "x".repeat(3 * 1024 * 1024))
        assert.equal(res.status, 413)
        assert.match(res.data.error, /too large/)
        assert.equal((await versions(analysisId)).length, 0)
    })

    test("an ordinary document still saves", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        assert.equal((await save(analysisId, "# CV\n" + "- a bullet\n".repeat(2000))).status, 200)
    })
})
