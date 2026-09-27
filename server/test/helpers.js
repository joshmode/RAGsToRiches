// Shared setup for the server tests: the real app on an in-memory database, and
// a stub engine so no test needs Python, a model or a network.
//
// node --test runs each file in its own process, so each file gets a fresh db.

import http from "node:http"
import { once } from "node:events"

process.env.NODE_ENV = "test"
process.env.DB_PATH = ":memory:"
process.env.ALLOW_MENTOR_REGISTRATION = "true"

// a tiny engine: each handler gets the parsed JSON body and returns [status, body]
export async function startEngine(handlers = {}) {
    const calls = []
    const server = http.createServer(async (req, res) => {
        let raw = ""
        for await (const chunk of req) raw += chunk
        const body = raw ? JSON.parse(raw) : {}
        calls.push({ path: req.url, body })
        const handler = handlers[req.url]
        if (!handler) {
            res.writeHead(404, { "Content-Type": "application/json" })
            return res.end(JSON.stringify({ error: `no stub for ${req.url}` }))
        }
        const out = await handler(body, res)
        if (out === undefined) return  // the handler wrote the response itself
        const [status, payload] = out
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(payload))
    })
    server.listen(0)
    await once(server, "listening")
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => closeServer(server),
    }
}

// fetch keeps sockets alive, and close() waits for every one of them
function closeServer(server) {
    return new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
    })
}

export async function startApp(engineUrl) {
    const { default: app } = await import("../app.js")
    app.locals.engineUrl = engineUrl
    const server = app.listen(0)
    await once(server, "listening")
    return {
        app,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => closeServer(server),
    }
}

// one signed-in user, holding cookies the way a browser would
export class Client {
    constructor(base) {
        this.base = base
        this.cookies = {}
        this.user = null
    }

    cookieHeader() {
        return Object.entries(this.cookies).map(([name, value]) => `${name}=${value}`).join("; ")
    }

    remember(res) {
        for (const line of res.headers.getSetCookie()) {
            const [pair] = line.split(";")
            const at = pair.indexOf("=")
            const name = pair.slice(0, at).trim()
            const value = pair.slice(at + 1).trim()
            if (!value || /expires=thu, 01 jan 1970/i.test(line)) delete this.cookies[name]
            else this.cookies[name] = value
        }
    }

    async request(method, path, body, { raw = false, headers = {} } = {}) {
        const res = await fetch(`${this.base}/api${path}`, {
            method,
            headers: {
                ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
                ...(Object.keys(this.cookies).length ? { Cookie: this.cookieHeader() } : {}),
                ...headers,
            },
            body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
        })
        this.remember(res)
        if (raw) return res
        const text = await res.text()
        let data = text
        try { data = JSON.parse(text) } catch { /* not json */ }
        return { status: res.status, data, headers: res.headers }
    }

    get(path, opts) { return this.request("GET", path, undefined, opts) }
    post(path, body, opts) { return this.request("POST", path, body ?? {}, opts) }
    put(path, body, opts) { return this.request("PUT", path, body ?? {}, opts) }
    delete(path, body, opts) { return this.request("DELETE", path, body, opts) }

    async register(username, role = "candidate") {
        const res = await this.post("/auth/register", { username, password: "correct-horse", display_name: username, role })
        if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.data)}`)
        this.user = res.data.user
        return this
    }
}

export async function signUp(base, username, role) {
    return new Client(base).register(username, role)
}

// an analysis row owned by `user`, without going through the engine
export async function seedAnalysis(user, { score = 55, results = {} } = {}) {
    const { getDb } = await import("../db.js")
    const db = getDb()
    const resume = db.prepare(
        "INSERT INTO resumes (user_id, filename, raw_bytes, parsed_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(user.id, "resume.pdf", Buffer.from("%PDF-1.4 test"), JSON.stringify({ sections: {} }))
    const analysis = db.prepare(
        "INSERT INTO analyses (resume_id, user_id, results_json, score_total, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(resume.lastInsertRowid, user.id, JSON.stringify({ rewrites: {}, sections: {}, ...results }), score)
    return { resumeId: Number(resume.lastInsertRowid), analysisId: Number(analysis.lastInsertRowid) }
}
