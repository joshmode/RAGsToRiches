// Review decisions are saved one at a time, and snapshots don't pile up per keypress.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { seedAnalysis, signUp, startApp, startEngine } from "./helpers.js"

let engine, app, alice, bob

before(async () => {
    engine = await startEngine()
    app = await startApp(engine.url)
    alice = await signUp(app.base, "alice")
    bob = await signUp(app.base, "bob")
})

after(async () => {
    await app.close()
    await engine.close()
})

const key = "EXPERIENCE:0:abc123"
const path = (id, k = key) => `/analysis/${id}/decisions/${encodeURIComponent(k)}`

describe("one decision", () => {
    test("is stored, changed and taken back", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        assert.equal((await alice.put(path(analysisId), { decision: true })).status, 200)
        assert.deepEqual((await alice.get(`/analysis/${analysisId}/decisions`)).data, { [key]: true })
        await alice.put(path(analysisId), { decision: false })
        assert.deepEqual((await alice.get(`/analysis/${analysisId}/decisions`)).data, { [key]: false })
        await alice.put(path(analysisId), { decision: null })
        assert.deepEqual((await alice.get(`/analysis/${analysisId}/decisions`)).data, {})
    })

    test("leaves the other decisions alone", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        await alice.put(path(analysisId, "a"), { decision: true })
        await alice.put(path(analysisId, "b"), { decision: false })
        assert.deepEqual((await alice.get(`/analysis/${analysisId}/decisions`)).data, { a: true, b: false })
    })

    test("a burst of decisions keeps one snapshot with the latest state", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        for (let i = 0; i < 10; i++) {
            await alice.put(path(analysisId, `k${i}`), { decision: i % 2 === 0 })
        }
        const revisions = (await alice.get(`/analysis/${analysisId}/revisions`)).data
        assert.equal(revisions.length, 1)
        assert.equal(Object.keys(revisions[0].decisions).length, 10)
    })

    test("must be a real decision", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        assert.equal((await alice.put(path(analysisId), { decision: "yes" })).status, 400)
    })

    test("can't be made on someone else's attempt", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        assert.equal((await bob.put(path(analysisId), { decision: true })).status, 404)
    })
})

describe("every decision at once", () => {
    test("replaces what was there", async () => {
        const { analysisId } = await seedAnalysis(alice.user)
        await alice.put(path(analysisId, "old"), { decision: true })
        await alice.post(`/analysis/${analysisId}/decisions`, { decisions: { a: true, b: true } })
        assert.deepEqual((await alice.get(`/analysis/${analysisId}/decisions`)).data, { a: true, b: true })
    })
})
