// the few fields a list or a chart needs from an analysis, stored beside the results
// blob so a history page doesn't parse fifty of them on every load
export function summaryOf(results) {
    const keywords = results?.jd_keywords || []
    const missing = results?.missing_keywords || []
    // the match is the keyword coverage. older attempts stored a model's guess
    // under match_pct, the coverage wins when the keywords are there
    const coverage = keywords.length ? Math.round((keywords.length - missing.length) / keywords.length * 100) : null
    const score = results?.score && typeof results.score === "object" ? results.score : {}
    return {
        company: String(results?.company || "").slice(0, 200),
        match_pct: coverage ?? (typeof results?.match_pct === "number" ? results.match_pct : null),
        score_json: JSON.stringify(score),
        timing_json: JSON.stringify(results?.timing || {}),
    }
}
