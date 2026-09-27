// The workspace's five tabs and the url for each. The attempt's id is in the path,
// so a refresh or a shared link opens the same attempt on the same tab.

export const TABS = [
    { key: "review", label: "Review", subs: [{ key: "", label: "Suggestions" }, { key: "sections", label: "Extracted sections" }] },
    { key: "job-fit", label: "Job Fit" },
    { key: "documents", label: "Documents", subs: [{ key: "cv", label: "Tailored CV" }, { key: "cover-letter", label: "Cover letter" }] },
    { key: "progress", label: "Progress" },
    { key: "mentor", label: "Mentor" },
]

// an attempt still streaming has no id yet
export function attemptPath(id, tab = "review", sub = "") {
    return `/attempts/${id ?? "new"}/${tab}${sub ? `/${sub}` : ""}`
}

// what a path asks for: the setup screen, past attempts, the sample, or an attempt's tab
export function readPath(pathname) {
    const parts = (pathname || "").split("/").filter(Boolean)
    if (parts[0] === "history") return { screen: "history" }
    if (parts[0] === "sample") return { screen: "sample" }
    if (parts[0] !== "attempts" || !parts[1]) return { screen: "setup" }
    const tab = TABS.find(t => t.key === parts[2]) || TABS[0]
    const subs = tab.subs || []
    const sub = subs.find(s => s.key && s.key === parts[3]) || subs[0]
    const id = parts[1] === "new" ? null : Number.parseInt(parts[1], 10) || null
    return { screen: "attempt", id, tab: tab.key, sub: sub?.key || "" }
}
