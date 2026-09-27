// The session is an httpOnly cookie now. It was a bearer token the client kept in
// localStorage, where any script on the page could read it, and the CSP that would
// have limited such a script was switched off.

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Client, signUp, startApp, startEngine } from "./helpers.js"

let engine, app

before(async () => {
    engine = await startEngine()
    app = await startApp(engine.url)
})

after(async () => {
    await app.close()
    await engine.close()
})

const sessionLine = res => res.headers.getSetCookie().find(line => line.startsWith("rtr_session="))

describe("the session cookie", () => {
    test("is httpOnly, same-site only, scoped to the api, and the token isn't in the body", async () => {
        const client = new Client(app.base)
        const res = await client.post("/auth/register", { username: "hana", password: "correct-horse", display_name: "Hana" }, { raw: true })
        const body = await res.json()
        const line = sessionLine(res)
        assert.equal(res.status, 201)
        assert.match(line, /HttpOnly/i)
        assert.match(line, /SameSite=Strict/i)
        assert.match(line, /Path=\/api/i)
        assert.match(line, /Max-Age=604800/i)
        assert.equal(body.token, undefined)
        assert.equal(body.user.username, "hana")
    })

    test("a guest's lasts only as long as the browser session", async () => {
        const guest = new Client(app.base)
        const res = await guest.post("/auth/guest", {}, { raw: true })
        assert.doesNotMatch(sessionLine(res), /Max-Age|Expires/i)
    })

    test("is what signs a request in, a bearer token isn't", async () => {
        const ivan = await signUp(app.base, "ivan")
        assert.equal((await ivan.get("/auth/me")).data.user.username, "ivan")
        const token = ivan.cookies.rtr_session
        const bare = new Client(app.base)
        assert.equal((await bare.get("/auth/me", { headers: { Authorization: `Bearer ${token}` } })).data.user, null)
        assert.equal((await bare.get("/analysis/history", { headers: { Authorization: `Bearer ${token}` } })).status, 401)
    })

    test("signing out clears it", async () => {
        const jade = await signUp(app.base, "jade")
        const res = await jade.post("/auth/logout")
        assert.equal(res.status, 200)
        assert.deepEqual(jade.cookies, {})
        assert.equal((await jade.get("/auth/me")).data.user, null)
    })

    test("a tampered cookie is refused", async () => {
        const kim = await signUp(app.base, "kim")
        const forged = kim.cookies.rtr_session.slice(0, -4) + "AAAA"
        assert.equal((await kim.get("/auth/me", { headers: { Cookie: `rtr_session=${forged}` } })).data.user, null)
        assert.equal((await kim.get("/analysis/history", { headers: { Cookie: `rtr_session=${forged}` } })).status, 401)
    })
})

describe("the content security policy", () => {
    test("allows only the app's own scripts", async () => {
        const res = await fetch(`${app.base}/`)
        const csp = res.headers.get("content-security-policy")
        assert.ok(csp)
        assert.match(csp, /default-src 'self'/)
        assert.match(csp, /script-src 'self'(;|$)/)
        assert.match(csp, /frame-ancestors 'none'/)
        assert.match(csp, /worker-src 'self' blob:/)
    })
})
