// echo of analyser.py's kw_freqs, compare-resume-jd doesn't return per-kw counts
export function kwFreqs(keywords, text) {
    const lower = (text || "").toLowerCase()
    const freqs = {}
    for (const kw of keywords) {
        const escaped = kw.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        // same token rule as analyser.py, \b can't sit next to "C++" or ".NET"
        const matches = lower.match(new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9+#])`, "g"))
        if (matches) freqs[kw] = matches.length
    }
    return freqs
}

// the job's missing keywords that the rewrites the candidate accepted work in. only
// ever ones the original bullets support, the engine checks that (weaving.py)
export function keywordsGained(result, decisions = {}) {
    const missing = new Set(result.missing_keywords || [])
    const gained = new Set()
    for (const items of Object.values(result.rewrites || {})) {
        for (const item of items) {
            if (decisions[item.id] !== true) continue
            for (const { keyword } of item.keywords_added || []) if (missing.has(keyword)) gained.add(keyword)
        }
    }
    return [...gained]
}
