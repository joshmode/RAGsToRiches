import { useMemo } from "react"
import { diffWordsWithSpace, diffLines } from "diff"

// every review surface diffs through here so red/green means the same everywhere
export function diffParts(before, after, mode = "words") {
    const a = typeof before === "string" ? before : ""
    const b = typeof after === "string" ? after : ""
    return mode === "lines" ? diffLines(a, b) : diffWordsWithSpace(a, b)
}

export function hasChanges(parts) {
    return parts.some(part => part.added || part.removed)
}

// one side off the shared part list so both panes agree on what changed
export function DiffPane({ parts, side }) {
    return <p className="diff-text">
        {parts.map((p, i) => {
            if (side === "before" ? p.added : p.removed) return null
            if (!p.added && !p.removed) return <span key={i}>{p.value}</span>
            return <mark key={i} className={p.removed ? "diff-del" : "diff-ins"}>{p.value}</mark>
        })}
    </p>
}

// reuses the feedback cards 
export function DocumentDiff({
    before, after, mode = "words",
    labelBefore = "Original", labelAfter = "Mentor rewrite",
    className = "",
}) {
    const parts = useMemo(() => diffParts(before, after, mode), [before, after, mode])
    const changed = hasChanges(parts)
    return <div className={`rewrite-grid diff-grid ${className}`}>
        <div className="rewrite-pane before">
            <span className="pane-label">{labelBefore}</span>
            <DiffPane parts={parts} side="before" />
        </div>
        <div className="rewrite-pane after">
            <span className="pane-label">
                {labelAfter}
                {!changed && <span className="diff-nochange">unchanged</span>}
            </span>
            <DiffPane parts={parts} side="after" />
        </div>
    </div>
}

// one pane for the timeline
export function InlineDiff({ before, after, side = "after", mode = "words" }) {
    const parts = useMemo(() => diffParts(before, after, mode), [before, after, mode])
    return <DiffPane parts={parts} side={side} />
}
