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
