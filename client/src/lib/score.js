export function getScoreCfg(score) {
    if (score >= 70) return { color: "#3F8F6B", label: "Strong" }
    if (score >= 50) return { color: "#B8853B", label: "Needs work" }
    return { color: "#BC5B57", label: "Needs improvement" }
}

// colour plus a label for heatmaop
export function heatmapQuality(quality) {
    const q = quality || 0
    if (q >= 85) return { label: "Excellent", color: "#2F7D5C" }
    if (q >= 65) return { label: "Good", color: "#6FA37A" }
    if (q >= 40) return { label: "Fair", color: "#C17F3A" }
    return { label: "Needs Work", color: "#BC5B57" }
}
