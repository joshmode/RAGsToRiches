// echo of analyser.py's kw_freqs, compare-resume-jd doesn't return per-kw counts
export function kwFreqs(keywords, text) {
    const lower = (text || "").toLowerCase()
    const freqs = {}
    for (const kw of keywords) {
        const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const matches = lower.match(new RegExp(`\\b${escaped}\\b`, "g"))
        if (matches) freqs[kw] = matches.length
    }
    return freqs
}
