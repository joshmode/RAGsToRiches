// Run with: npm test

import assert from "node:assert/strict"
import { test } from "node:test"

import { findRange, normalise, pageText, rangeRects, searchFragments } from "./pdfText.js"

// what PDF.js hands back for two lines of a resume
const items = [
    { str: "- Worked on the checkout service with the", hasEOL: true },
    { str: "payments team to improve API performance", hasEOL: true },
    { str: "- Wrote documentation", hasEOL: false },
    { str: " for the deploy tool", hasEOL: true },
]

// each item one 10px-high row, 5px per character, so rects are easy to check
const toViewport = item => {
    const row = items.indexOf(item)
    return { left: 0, top: row * 10, width: item.str.length * 5, height: 10 }
}

test("normalising collapses whitespace and keeps a map back", () => {
    const { text, map } = normalise("  Worked   On\nIt ")
    assert.equal(text, "worked on it ")
    assert.equal(map[0], 2)
    assert.equal(map[7], 11)
})

test("a bullet that wraps onto a second line is found across both", () => {
    const page = pageText(items)
    const range = findRange(page, "Worked on the checkout service with the payments team to improve API performance")
    assert.ok(range)
    const rects = rangeRects(page, range, toViewport)
    assert.equal(rects.length, 2)
    assert.equal(rects[0].top, 0)
    assert.equal(rects[1].top, 10)
    // the "- " in front isn't highlighted
    assert.equal(rects[0].left, 10)
})

test("a bullet split into several items on one line is found", () => {
    const page = pageText(items)
    const rects = rangeRects(page, findRange(page, "Wrote documentation for the deploy tool"), toViewport)
    assert.equal(rects.length, 2)
})

test("text that isn't on the page isn't found", () => {
    assert.equal(findRange(pageText(items), "Led a migration to Kubernetes across twelve services"), null)
})

test("long bullets fall back to shorter runs of words", () => {
    const phrases = searchFragments("one two three four five six seven eight nine ten eleven twelve")
    assert.equal(phrases.length, 3)
    assert.equal(phrases[1], "one two three four five six seven eight nine ten")
})
