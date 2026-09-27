// Run with: npm test

import assert from "node:assert/strict"
import { test } from "node:test"

import { keywordsGained, kwFreqs } from "./keywords.js"

test("keywords ending in symbols are found", () => {
    const text = "Shipped services in C++ and C#, then ported them to .NET"
    assert.deepEqual(kwFreqs(["C++", "C#", ".NET"], text), { "C++": 1, "C#": 1, ".NET": 1 })
})

test("a short keyword doesn't match inside a longer one", () => {
    assert.deepEqual(kwFreqs(["C", "Java"], "Wrote C++ and JavaScript"), {})
})

test("matching ignores case and counts every mention", () => {
    assert.deepEqual(kwFreqs(["Python"], "python scripts, PYTHON services"), { Python: 2 })
})

test("only accepted rewrites count toward the keywords gained", () => {
    const result = {
        missing_keywords: ["Python", "CI/CD"],
        rewrites: { EXPERIENCE: [
            { id: "a", keywords_added: [{ keyword: "Python", via: "implied", evidence: "Flask" }] },
            { id: "b", keywords_added: [{ keyword: "CI/CD", via: "alias", evidence: "CI" }] },
            { id: "c", keywords_added: [{ keyword: "Go", via: "resume", evidence: "Go" }] },
        ] },
    }
    assert.deepEqual(keywordsGained(result, { a: true, b: false, c: true }), ["Python"])
    assert.deepEqual(keywordsGained(result, {}), [])
})
