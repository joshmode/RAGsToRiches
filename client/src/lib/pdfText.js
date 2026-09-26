// Finding a bullet's text on a rendered PDF page, for drawing highlights in the
// browser. Pure functions over PDF.js text items so they can be tested without it.

// one page's text as a single string, remembering which item each run came from
export function pageText(items) {
    let text = ""
    const spans = []
    for (const item of items) {
        if (item.str) {
            spans.push({ start: text.length, end: text.length + item.str.length, item })
            text += item.str
        }
        if (item.hasEOL) text += " "
    }
    return { text, spans }
}

// lower case with whitespace runs collapsed, plus where each character came from
export function normalise(raw) {
    let text = ""
    const map = []
    let space = true
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]
        if (/\s/.test(ch)) {
            if (!space) {
                text += " "
                map.push(i)
                space = true
            }
            continue
        }
        text += ch.toLowerCase()
        map.push(i)
        space = false
    }
    return { text, map }
}

// the whole bullet first, then shorter runs of it, the same order the old server
// side highlighter searched in. a line break or a ligature can split the full text
export function searchFragments(text) {
    const cleaned = normalise(text || "").text.trim()
    const words = cleaned.split(" ")
    const phrases = [cleaned]
    if (words.length > 18) phrases.push(words.slice(0, 18).join(" "))
    if (words.length > 10) phrases.push(words.slice(0, 10).join(" "), words.slice(-10).join(" "))
    return phrases.filter(phrase => phrase.length >= 20)
}

// the raw character range of the first fragment found on the page, or null
export function findRange(page, query) {
    const norm = normalise(page.text)
    for (const phrase of searchFragments(query)) {
        const at = norm.text.indexOf(phrase)
        if (at !== -1) return { start: norm.map[at], end: norm.map[at + phrase.length - 1] + 1 }
    }
    return null
}

// rectangles, in viewport pixels, covering a raw character range. an item only
// partly in range gets a proportional slice of its width
export function rangeRects(page, range, toViewport) {
    const rects = []
    for (const { start, end, item } of page.spans) {
        if (end <= range.start || start >= range.end) continue
        const box = toViewport(item)
        const length = Math.max(1, item.str.length)
        const from = Math.max(range.start, start) - start
        const to = Math.min(range.end, end) - start
        rects.push({
            left: box.left + box.width * (from / length),
            top: box.top,
            width: box.width * ((to - from) / length),
            height: box.height,
        })
    }
    return rects
}
