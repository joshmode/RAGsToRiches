const OVERSTATED = {
    role: "Claims more seniority than your original",
    credit: "Takes personal credit for team work",
    scope: "Widens the scope of what you did",
    invented: "Mentions something your original doesn't",
}

// what the claim checks found on one rewrite, worded for the candidate. the engine
// runs the figure, verb and keyword checks on every rewrite, the critic only when it's on
export function claimFlags(item) {
    const flags = []
    const critic = item.critic?.status
    // a figure the critic checked and judged supported isn't an open question
    if (item.new_claims?.length && critic !== "passed") {
        flags.push({
            kind: "figure",
            title: "Adds figures your original doesn't have",
            detail: `New here: ${item.new_claims.join(", ")}. Only accept if ${item.new_claims.length === 1 ? "it's" : "they're"} true${critic === "unavailable" ? " (the critic couldn't check this one)" : ""}.`,
        })
    }
    if (item.verb_escalation) {
        flags.push({ kind: "role", title: "Claims more responsibility", detail: item.verb_escalation.detail })
    }
    if (item.overstated && !(item.overstated.kind === "role" && item.verb_escalation)) {
        flags.push({ kind: item.overstated.kind, title: OVERSTATED[item.overstated.kind] || OVERSTATED.role, detail: item.overstated.reason })
    }
    const unsupported = item.unsupported_keywords || []
    if (unsupported.length) {
        flags.push({
            kind: "keyword",
            title: unsupported.length === 1 ? "Adds a job keyword your original doesn't mention" : "Adds job keywords your original doesn't mention",
            detail: `New here: ${unsupported.join(", ")}. Only accept if you really used ${unsupported.length === 1 ? "it" : "them"} for this work.`,
        })
    }
    return flags
}

const VIA = {
    alias: evidence => `you wrote "${evidence}"`,
    implied: evidence => `you named ${evidence}`,
    reworded: evidence => `you wrote "${evidence}"`,
    resume: () => "it's on your resume",
}

// job keywords the rewrite worked in, each with what in the original backs it
export function keywordNote(item) {
    const added = item.keywords_added || []
    if (!added.length) return ""
    const parts = added.map(k => `${k.keyword} (${(VIA[k.via] || VIA.resume)(k.evidence)})`)
    return `Uses the job's ${added.length === 1 ? "keyword" : "keywords"} ${parts.join(", ")}.`
}

export function isFlagged(item) {
    return claimFlags(item).length > 0
}

// what the critic did, when it did something worth knowing
export function criticNote(item) {
    const critic = item.critic?.status
    if (critic === "repaired") return "The critic caught an unsupported figure in the first draft and this is the corrected version."
    if (critic === "passed" && item.new_claims?.length) return "The critic checked the new figure against your original and found it supported."
    return ""
}

// a suggestion worth reviewing at all: rewritten, not a label or a failure
export function isActionable(item) {
    return item.framework_used !== "none" && item.framework_used !== "error" && item.original !== item.rewritten
}
