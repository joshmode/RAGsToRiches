// Run with: npm test

import assert from "node:assert/strict"
import { test } from "node:test"

import { attemptPath, readPath } from "./routes.js"

test("an attempt's tab round-trips through its path", () => {
    assert.equal(attemptPath(12, "documents", "cover-letter"), "/attempts/12/documents/cover-letter")
    assert.deepEqual(readPath("/attempts/12/documents/cover-letter"), { screen: "attempt", id: 12, tab: "documents", sub: "cover-letter" })
})

test("a tab without a sub opens its first one", () => {
    assert.deepEqual(readPath("/attempts/12/documents"), { screen: "attempt", id: 12, tab: "documents", sub: "cv" })
    assert.deepEqual(readPath("/attempts/12/review"), { screen: "attempt", id: 12, tab: "review", sub: "" })
})

test("an attempt still streaming has no id", () => {
    assert.equal(attemptPath(null), "/attempts/new/review")
    assert.equal(readPath("/attempts/new/review").id, null)
})

test("unknown tabs and subs fall back instead of breaking", () => {
    assert.deepEqual(readPath("/attempts/7/nonsense/x"), { screen: "attempt", id: 7, tab: "review", sub: "" })
    assert.equal(readPath("/attempts/7/review/nope").sub, "")
})

test("everything else is the setup screen", () => {
    assert.equal(readPath("/").screen, "setup")
    assert.equal(readPath("/attempts").screen, "setup")
    assert.equal(readPath("/history").screen, "history")
    assert.equal(readPath("/sample").screen, "sample")
})
