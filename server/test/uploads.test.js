// Uploads are keyed on the file's bytes, so re-analysing hits the cache.
//
// Every Analyse click used to re-upload the file, make a new resume row, and
// re-parse (or re-OCR) it. The cache key used that fresh row id, so it never hit.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { signUp, startApp, startEngine } from "./helpers.js"

const PARSED = {
    raw_text: "Jordan Lee\nEXPERIENCE\n- Built the billing service",
    contact: { name: "Jordan Lee" },
    sections: { EXPERIENCE: ["- Built the billing service"] },
    warnings: [],
    ocr_used: false,
}

let engine, app, alice, bob

before(async () => {
    engine = await startEngine({
        "/parse": () => [200, PARSED],
        "/analyse": body => [200, {
            score: { total: 61 }, rewrites: {}, sections: body.resume_json.sections, model: "stub-model",
        }],
    })
    app = await startApp(engine.url)
    alice = await signUp(app.base, "alice")
    bob = await signUp(app.base, "bob")
})

after(async () => {
    await app.close()
    await engine.close()
})

function form(bytes, name = "resume.pdf") {
    const data = new FormData()
    data.append("file", new Blob([bytes], { type: "application/pdf" }), name)
    return data
}

const calls = path => engine.calls.filter(call => call.path === path).length

async function waitForJob(client, jobId) {
    for (let i = 0; i < 50; i++) {
        const res = await client.get(`/analysis/jobs/${jobId}`)
        if (res.data.status === "completed" || res.data.status === "failed") return res.data
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error("job never finished")
}

describe("uploading", () => {
    test("the same file twice reuses the row and the parse", async () => {
        const before = calls("/parse")
        const first = await alice.post("/analysis/upload", form("%PDF-1.4 alice"))
        const second = await alice.post("/analysis/upload", form("%PDF-1.4 alice"))
        assert.equal(first.status, 200)
        assert.equal(second.data.resume_id, first.data.resume_id)
        assert.equal(second.data.reused, true)
        assert.deepEqual(second.data.parsed, PARSED)
        assert.equal(calls("/parse") - before, 1)
    })

    test("a different file is a different resume", async () => {
        const first = await alice.post("/analysis/upload", form("%PDF-1.4 one"))
        const second = await alice.post("/analysis/upload", form("%PDF-1.4 two"))
        assert.notEqual(second.data.resume_id, first.data.resume_id)
    })

    test("the same bytes under another extension are parsed again", async () => {
        const md = await alice.post("/analysis/upload", form("# Jordan", "resume.md"))
        const txt = await alice.post("/analysis/upload", form("# Jordan", "resume.txt"))
        assert.notEqual(txt.data.resume_id, md.data.resume_id)
    })

    test("another user's identical file is theirs alone", async () => {
        const mine = await alice.post("/analysis/upload", form("%PDF-1.4 shared"))
        const theirs = await bob.post("/analysis/upload", form("%PDF-1.4 shared"))
        assert.notEqual(theirs.data.resume_id, mine.data.resume_id)
        assert.equal((await bob.get(`/analysis/resumes/${mine.data.resume_id}/file`)).status, 404)
    })
})

describe("analysing", () => {
    test("a repeat analysis of the same file and job hits the cache", async () => {
        const upload = await alice.post("/analysis/upload", form("%PDF-1.4 cached"))
        const body = { resume_id: upload.data.resume_id, job_description: "Python", provider: "demo" }
        const before = calls("/analyse")

        const first = await waitForJob(alice, (await alice.post("/analysis/run", body)).data.job_id)
        // the client re-uploads on every click, which now lands on the same row
        const again = await alice.post("/analysis/upload", form("%PDF-1.4 cached"))
        const second = await waitForJob(alice, (await alice.post("/analysis/run", { ...body, resume_id: again.data.resume_id })).data.job_id)

        assert.equal(calls("/analyse") - before, 1)
        assert.equal(second.analysis_id, first.analysis_id)
        assert.equal(first.results.model, "stub-model")
    })

    test("the engine gets the parse the server stored, not the client's copy", async () => {
        const upload = await alice.post("/analysis/upload", form("%PDF-1.4 trusted"))
        const job = await alice.post("/analysis/run", {
            resume_id: upload.data.resume_id, job_description: "", provider: "demo",
            resume_json: { raw_text: "tampered", sections: { EXPERIENCE: ["- Invented a time machine"] } },
        })
        await waitForJob(alice, job.data.job_id)
        const sent = engine.calls.filter(call => call.path === "/analyse").at(-1).body
        assert.deepEqual(sent.resume_json, PARSED)
    })
})
