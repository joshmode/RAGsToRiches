// Run with: node --test client/src/api/stream.test.js
//
// Covers the SSE frame parser, which is the part that has to be right: a network
// chunk can split a frame anywhere, and a dropped or duplicated event would show
// the user the wrong thing.

import assert from "node:assert/strict"
import { test } from "node:test"

import { parseSSEBuffer } from "./stream.js"

test("parses a single complete frame", () => {
    const { events, rest } = parseSSEBuffer('data: {"stage":"started"}\n\n')
    assert.deepEqual(events, [{ stage: "started" }])
    assert.equal(rest, "")
})

test("parses several frames from one chunk", () => {
    const buffer = 'data: {"stage":"a"}\n\ndata: {"stage":"b"}\n\n'
    const { events, rest } = parseSSEBuffer(buffer)
    assert.deepEqual(events.map(e => e.stage), ["a", "b"])
    assert.equal(rest, "")
})

test("keeps a trailing partial frame for the next chunk", () => {
    const { events, rest } = parseSSEBuffer('data: {"stage":"a"}\n\ndata: {"stage":"b"')
    assert.deepEqual(events, [{ stage: "a" }])
    assert.equal(rest, 'data: {"stage":"b"')
})

test("a frame split across two chunks is reassembled", () => {
    const first = parseSSEBuffer('data: {"stage":"chun')
    assert.deepEqual(first.events, [])

    const second = parseSSEBuffer(first.rest + 'k","completed":1}\n\n')
    assert.deepEqual(second.events, [{ stage: "chunk", completed: 1 }])
    assert.equal(second.rest, "")
})

test("handles a multi-line data payload", () => {
    const { events } = parseSSEBuffer('data: {"stage":\ndata: "started"}\n\n')
    assert.deepEqual(events, [{ stage: "started" }])
})

test("ignores comment and field lines that are not data", () => {
    const { events } = parseSSEBuffer(': keep-alive\nevent: message\ndata: {"stage":"a"}\n\n')
    assert.deepEqual(events, [{ stage: "a" }])
})

test("drops an unparseable frame without losing the ones around it", () => {
    const buffer = 'data: {"stage":"a"}\n\ndata: not json\n\ndata: {"stage":"b"}\n\n'
    const { events } = parseSSEBuffer(buffer)
    assert.deepEqual(events.map(e => e.stage), ["a", "b"])
})

test("an empty buffer yields nothing", () => {
    assert.deepEqual(parseSSEBuffer(""), { events: [], rest: "" })
})

test("a frame with no data lines is skipped", () => {
    const { events, rest } = parseSSEBuffer(": just a comment\n\n")
    assert.deepEqual(events, [])
    assert.equal(rest, "")
})

test("preserves payload content containing blank-line-like sequences", () => {
    const payload = { stage: "chunk", rewrites: [{ rewritten: "line one" }] }
    const { events } = parseSSEBuffer(`data: ${JSON.stringify(payload)}\n\n`)
    assert.deepEqual(events, [payload])
})

test("a realistic sequence ends with done carrying the result", () => {
    const frames = [
        { stage: "started" },
        { stage: "rewriting", chunks: 2 },
        { stage: "chunk", completed: 1, total: 2 },
        { stage: "chunk", completed: 2, total: 2 },
        { stage: "done", result: { score: { total: 71 } } },
    ]
    const buffer = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("")
    const { events, rest } = parseSSEBuffer(buffer)
    assert.equal(events.length, 5)
    assert.equal(rest, "")
    assert.equal(events.at(-1).result.score.total, 71)
})
