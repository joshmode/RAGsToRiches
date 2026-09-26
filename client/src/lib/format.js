export function formatDuration(ms) {
    const totalSeconds = ms / 1000
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`
    // round the whole thing first or 119.6s comes out "1 min 60 s"
    const rounded = Math.round(totalSeconds)
    const minutes = Math.floor(rounded / 60)
    const seconds = rounded % 60
    return `${minutes} min ${seconds} s`
}

export function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return ""
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s
}

// sqlite datetimes are naive utc
export function parseTs(value) {
    if (!value) return null
    const iso = typeof value === "string" && value.includes(" ") && !value.includes("T") ? `${value.replace(" ", "T")}Z` : value
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d
}

export function formatShortDate(value) {
    const d = parseTs(value)
    return d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : ""
}

// for where a bare date can't distinguish
export function formatDateTime(value) {
    const d = parseTs(value)
    return d ? d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : ""
}

export function fileSafe(s) {
    return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "DOCUMENT"
}
