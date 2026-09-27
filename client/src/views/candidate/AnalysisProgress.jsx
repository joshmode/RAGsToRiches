import { useEffect, useState } from "react"
import { Check, Clock, Loader2 } from "lucide-react"

// every stage here is an event the engine actually sent, in the order it sends them
const STAGES = [
    { key: "uploading", label: "Reading your resume" },
    { key: "planned", label: "Picking the bullets worth rewriting" },
    { key: "retrieved", label: "Matching each bullet to writing guides" },
    { key: "keywords", label: "Reading the job description" },
    { key: "rewriting", label: "Rewriting bullets" },
    { key: "scored", label: "Scoring your resume" },
]
const ORDER = STAGES.map(stage => stage.key)
// these arrive when their step is done, rewriting arrives as it starts
const FINISHED_ON_ARRIVAL = new Set(["planned", "retrieved", "keywords", "scored"])

// fold one stream event into the progress state
export function advanceProgress(progress, event) {
    const next = { ...progress }
    if (ORDER.includes(event.stage) && ORDER.indexOf(event.stage) > ORDER.indexOf(progress.stage)) {
        next.stage = event.stage
    }
    if (event.stage === "planned") next.bullets = event.bullets
    if (event.stage === "rewriting") {
        next.chunksTotal = event.chunks
        next.rewritingSince = Date.now()
    }
    if (event.stage === "chunk") {
        next.chunksDone = event.completed
        next.chunksTotal = event.total
        next.suggestions = (progress.suggestions || 0) + (event.rewrites || [])
            .filter(rw => rw.framework_used !== "none" && rw.framework_used !== "error" && rw.original !== rw.rewritten).length
    }
    if (event.stage === "keywords") {
        next.keywords = event.failed ? "failed" : event.found
    }
    return next
}

function useSeconds(since) {
    const [now, setNow] = useState(Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
    }, [])
    return Math.max(0, Math.round((now - since) / 1000))
}

export function AnalysisProgress({ progress }) {
    const elapsed = useSeconds(progress.startedAt)
    // no job description, nothing to read
    const stages = progress.withJd ? STAGES : STAGES.filter(stage => stage.key !== "keywords")
    const reached = stages.reduce((at, stage, idx) => (ORDER.indexOf(stage.key) <= ORDER.indexOf(progress.stage) ? idx : at), 0)
    // the step in progress: the one after a step that reports when it's finished
    const current = FINISHED_ON_ARRIVAL.has(stages[reached].key) ? reached + 1 : reached
    const done = progress.chunksDone || 0
    const total = progress.chunksTotal || 0
    // measured, not guessed: the pace of the batches that have finished
    const rewritingFor = progress.rewritingSince ? (Date.now() - progress.rewritingSince) / 1000 : 0
    const remaining = done > 0 && total > done ? Math.round(rewritingFor / done * (total - done)) : null
    const percent = Math.min(100, Math.round(((current + (total ? done / total : 0)) / stages.length) * 100))

    return <section className="card analysis-progress" aria-live="polite">
        <div className="analysis-progress-head">
            <span className="section-label">Analysing</span>
            <span className="processing-timer"><Clock size={12} /> {elapsed}s{remaining !== null ? ` · about ${remaining}s left` : ""}</span>
        </div>
        <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Analysis progress">
            <span style={{ width: `${percent}%` }} />
        </div>
        <ol className="analysis-stages">
            {stages.map((stage, idx) => {
                const state = idx < current ? "done" : idx === current ? "active" : "upcoming"
                return <li key={stage.key} className={`analysis-stage ${state}`}>
                    {state === "done" ? <Check size={13} /> : state === "active" ? <Loader2 size={13} className="spin-icon" /> : <span className="analysis-stage-dot" />}
                    <span>
                        {stage.label}
                        {stage.key === "planned" && progress.bullets != null && state !== "upcoming" && ` · ${progress.bullets} lines found`}
                        {stage.key === "rewriting" && total > 0 && ` · batch ${done} of ${total}`}
                    </span>
                </li>
            })}
        </ol>
        {progress.suggestions > 0 && <p className="muted">{progress.suggestions} suggestion{progress.suggestions === 1 ? "" : "s"} ready to review below while the rest finish.</p>}
        {progress.keywords === "failed" && <p className="muted">The job description couldn't be read this time, so the keyword match will be missing.</p>}
        {typeof progress.keywords === "number" && progress.keywords > 0 && <p className="muted">Read the job description: {progress.keywords} keywords to match. Rewrites only use the ones your own bullets already back up.</p>}
    </section>
}
