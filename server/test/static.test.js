// The built client is served by the api. A tab left open across a deploy asks for
// hashed files the new build doesn't have, and getting the page's html back for
// them failed as a module script instead of a plain 404.

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"

import { startApp, startEngine } from "./helpers.js"

let engine, app, dist

before(async () => {
    // The API serves the built client in production. Supply a tiny build so
    // `npm test` works from a clean checkout, before Vite has run.
    dist = await fs.mkdtemp(path.join(os.tmpdir(), "ragstoriches-client-"))
    await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>test client</title>")
    process.env.CLIENT_DIST = dist
    engine = await startEngine()
    app = await startApp(engine.url)
})

after(async () => {
    await app.close()
    await engine.close()
    await fs.rm(dist, { recursive: true, force: true })
    delete process.env.CLIENT_DIST
})

test("an asset from an older build is a 404, not the page's html", async () => {
    const res = await fetch(`${app.base}/assets/PdfViewer-from-last-week.js`)
    assert.equal(res.status, 404)
})

test("any other path is still the app", async () => {
    const res = await fetch(`${app.base}/attempts/12/review`)
    assert.notEqual(res.status, 404)
})
