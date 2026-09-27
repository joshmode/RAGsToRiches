// The built client is served by the api. A tab left open across a deploy asks for
// hashed files the new build doesn't have, and getting the page's html back for
// them failed as a module script instead of a plain 404.

import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { startApp, startEngine } from "./helpers.js"

let engine, app

before(async () => {
    engine = await startEngine()
    app = await startApp(engine.url)
})

after(async () => {
    await app.close()
    await engine.close()
})

test("an asset from an older build is a 404, not the page's html", async () => {
    const res = await fetch(`${app.base}/assets/PdfViewer-from-last-week.js`)
    assert.equal(res.status, 404)
})

test("any other path is still the app", async () => {
    const res = await fetch(`${app.base}/attempts/12/review`)
    assert.notEqual(res.status, 404)
})
