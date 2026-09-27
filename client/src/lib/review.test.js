// Run with: npm test

import assert from "node:assert/strict"
import { test } from "node:test"

import { claimFlags, criticNote, isActionable, isFlagged, keywordNote } from "./review.js"

const base = { original: "Wrote the docs", rewritten: "Wrote the docs, cutting onboarding by 40%", framework_used: "STAR" }

test("an invented figure is flagged", () => {
    const flags = claimFlags({ ...base, new_claims: ["40%"] })
    assert.equal(flags.length, 1)
    assert.equal(flags[0].kind, "figure")
    assert.match(flags[0].detail, /40%/)
})

test("a figure the critic judged supported is not", () => {
    assert.equal(isFlagged({ ...base, new_claims: ["40%"], critic: { status: "passed" } }), false)
    assert.match(criticNote({ ...base, new_claims: ["40%"], critic: { status: "passed" } }), /supported/)
})

test("a figure the critic couldn't check says so", () => {
    const [flag] = claimFlags({ ...base, new_claims: ["40%"], critic: { status: "unavailable" } })
    assert.match(flag.detail, /couldn't check/)
})

test("an escalation and a role finding show once", () => {
    const flags = claimFlags({
        ...base, verb_escalation: { detail: "helped to led" }, overstated: { kind: "role", reason: "more senior" },
    })
    assert.deepEqual(flags.map(f => f.kind), ["role"])
})

test("other overstated findings keep their own flag", () => {
    const flags = claimFlags({ ...base, overstated: { kind: "credit", reason: "team work" } })
    assert.deepEqual(flags.map(f => f.kind), ["credit"])
})

test("labels, failures and unchanged lines aren't suggestions", () => {
    assert.equal(isActionable(base), true)
    assert.equal(isActionable({ ...base, framework_used: "none" }), false)
    assert.equal(isActionable({ ...base, framework_used: "error" }), false)
    assert.equal(isActionable({ ...base, rewritten: base.original }), false)
})

test("a job keyword the original doesn't support is flagged", () => {
    const [flag] = claimFlags({ ...base, unsupported_keywords: ["Kubernetes", "AWS"] })
    assert.equal(flag.kind, "keyword")
    assert.match(flag.detail, /Kubernetes, AWS/)
})

test("a worked in keyword says what backs it, and isn't a flag", () => {
    const item = { ...base, keywords_added: [
        { keyword: "Python", via: "implied", evidence: "Flask" },
        { keyword: "CI/CD", via: "alias", evidence: "CI" },
    ] }
    assert.equal(isFlagged(item), false)
    assert.equal(keywordNote(item), 'Uses the job\'s keywords Python (you named Flask), CI/CD (you wrote "CI").')
    assert.equal(keywordNote(base), "")
})
