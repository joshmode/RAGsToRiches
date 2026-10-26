// Upstream failures must stay useful. A proxy page or engine crash is often plain
// text, and blindly parsing it as JSON used to become a generic 500.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { signUp, startApp, startEngine } from "./helpers.js"

const PARSED = {
    raw_text: "Jordan Lee\nEXPERIENCE\n- Built the billing service",
    contact: { name: "Jordan Lee" },
    sections: { EXPERIENCE: ["- Built the billing service"] },
    warnings: [], ocr_used: false,
    preview: { score: { total: 61 }, bullets: 1, already_strong: 0, to_rewrite: 1 },
}

let engine, app, alice

function upload(client) {
    const data = new FormData()
    data.append("file", new Blob(["%PDF-1.4 errors"]), "resume.pdf")
    return client.post("/analysis/upload", data)
}

before(async () => {
    engine = await startEngine({
        "/parse": () => [200, PARSED],
        "/gen-cv": (_body, res) => {
            res.writeHead(413, { "Content-Type": "text/plain" })
            res.end("Request Entity Too Large")
        },
    })
    app = await startApp(engine.url)
    alice = await signUp(app.base, "alice")
})

after(async () => {
    await app.close()
    await engine.close()
})

describe("engine errors", () => {
    test("a plain-text upstream failure is passed through, not turned into a 500", async () => {
        const parsed = await upload(alice)
        const res = await alice.post("/generate/cv", {
            analysis_id: null,
            resume_json: parsed.data.parsed,
            job_description: "",
            provider: "demo",
        })
        assert.equal(res.status, 413)
        assert.match(res.data.error, /too large/i)
    })
})
