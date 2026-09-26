export function getScoreCfg(score) {
    if (score >= 70) return { color: "#3F8F6B", label: "Strong" }
    if (score >= 50) return { color: "#B8853B", label: "Needs work" }
    return { color: "#BC5B57", label: "Needs improvement" }
}

// colour plus a label for heatmaop
export function heatmapQuality(quality) {
    if (quality == null) return { label: "Not graded", color: "#C1C5CB" }
    const q = quality || 0
    if (q >= 85) return { label: "Excellent", color: "#2F7D5C" }
    if (q >= 65) return { label: "Good", color: "#6FA37A" }
    if (q >= 40) return { label: "Fair", color: "#C17F3A" }
    return { label: "Needs Work", color: "#BC5B57" }
}

// the rubric has nothing to grade in a skills list. older attempts stored those as
// 100% with no bullets, so both shapes read as not graded
export function isGraded(section) {
    return !!section && section.quality != null && section.bullet_count !== 0
}

// older attempts stored the base/sections/keywords breakdown, keep them readable
export function scoreBreakdown(scoreData) {
    if (!scoreData || typeof scoreData !== "object") return ["Score breakdown not available"]
    const total = scoreData.total || 0
    if ("quantification" in scoreData) {
        const max = scoreData.weights || { quantification: 40, action_verbs: 30, structure: 30 }
        const bullets = scoreData.bullets_scored || 0
        return [
            `Quantified results: ${scoreData.quantification}/${max.quantification}`,
            `Action verbs: ${scoreData.action_verbs}/${max.action_verbs}`,
            `Structure: ${scoreData.structure}/${max.structure}`,
            bullets ? `Total: ${total}/100, averaged over ${bullets} bullet${bullets === 1 ? "" : "s"}` : "No bullets found to score",
        ]
    }
    return [
        `Base: ${scoreData.base || 0}`,
        `Sections: +${scoreData.sections || 0}`,
        `Keywords: +${scoreData.keywords || 0}`,
        `Bullet Quality: +${scoreData.bullet_quality || 0}`,
        `Action Verbs: +${scoreData.action_verbs || 0}`,
        `Warnings: ${scoreData.warnings || 0}`,
        `Total: ${total}/100`,
    ]
}
