import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, Info, Lightbulb, ShieldCheck, Tag, X, XCircle } from "lucide-react"
import api from "../../api/client"
import { getError } from "../../lib/errors"
import { DocumentDiff } from "../../components/DocumentDiff"
import { MentorSuggestionBlock, editSupersedes } from "../../components/MentorSuggestionBlock"
import { AnnotationThread } from "../../components/AnnotationThread"
import { toast } from "../../components/Toast"
import { SEVERITY_LABEL, claimFlags, criticNote, isActionable, isFlagged, keywordNote } from "../../lib/review"

const PdfViewer = lazy(() => import("../../components/PdfViewer"))

function decisionMark(state, flagged) {
    if (state === true) return "✓ "
    if (state === false) return "✗ "
    return flagged ? "⚠ " : "• "
}

// what the checks caught across the whole attempt, so a clean run says so too
function GuardSummary({ result, flagged }) {
    const guard = result.claim_guard || {}
    const parts = []
    if (flagged) parts.push(`${flagged} flagged for you to check`)
    if (guard.withheld) parts.push(`${guard.withheld} withheld after the critic couldn't fix ${guard.withheld === 1 ? "it" : "them"}`)
    if (result.already_strong) parts.push(`${result.already_strong} already strong, left as ${result.already_strong === 1 ? "it is" : "they are"}`)
    if (result.rewrite_skipped) parts.push(`${result.rewrite_skipped} not rewritten: the model didn't answer in time`)
    if (!parts.length) return <p className="guard-summary"><ShieldCheck size={14} /> Claim checks found nothing invented or overstated.</p>
    return <p className="guard-summary"><ShieldCheck size={14} /> Claim checks: {parts.join(" · ")}.</p>
}

export function RewriteReview({ result, file, decisions, setDecisions, analysisId, pending = false }) {
    const [activeKey, setActiveKey] = useState(null)
    const [error, setError] = useState("")
    const [mentorEdits, setMentorEdits] = useState({})
    const actionable = useMemo(() => Object.entries(result.rewrites || {}).flatMap(([section, items]) => items.map((item, index) => ({ section, item, index, key: item.id || `${section}_${index}` })).filter(({ item }) => isActionable(item))), [result])
    const flaggedCount = actionable.filter(({ item }) => isFlagged(item)).length
    const count = actionable.length
    // by key, not index: suggestions that land mid-review, or the final order, mustn't
    // swap the one on screen for another
    const foundAt = actionable.findIndex(({ key }) => key === activeKey)
    const active = foundAt === -1 ? 0 : foundAt
    const current = actionable[active]
    const goTo = idx => setActiveKey(actionable[(idx + count) % count]?.key ?? null)

    // accepted mentor rewrites beat the llm's own
    useEffect(() => {
        if (!analysisId) { setMentorEdits({}); return }
        api.get("/mentor/feedback/inbox").then(res => {
            const map = {}
            for (const f of res.data) {
                if (f.feedback_type === "edit" && f.analysis_id === analysisId && f.suggestion_key) map[f.suggestion_key] = f
            }
            setMentorEdits(map)
        }).catch(() => setMentorEdits({}))
    }, [analysisId])

    // reanalysing on this tab doesn't change the view, so this never remounts on its own
    useEffect(() => { setError("") }, [analysisId])

    // drawn in the browser now, so moving between suggestions is only a scroll
    const highlights = useMemo(() => actionable.map(({ key, item }) => ({
        id: key, text: item.highlight_text || item.original || "", severity: item.severity || "yellow",
    })), [actionable])
    const isPdf = file?.type === "application/pdf"

    // decisions show at once and save in the background. one request after another,
    // so a quick change of mind can't land before the choice it replaced
    const queueRef = useRef(Promise.resolve())
    function persist(request) {
        if (!analysisId) return  // still streaming, App saves these once the attempt has an id
        queueRef.current = queueRef.current.then(request).then(
            () => setError(""),
            err => setError(`Couldn't save a decision: ${getError(err)}. It's still shown here, so try again.`),
        )
    }

    // every decision at once, for accept all and clear
    function save(next) {
        setDecisions(next)
        persist(() => api.post(`/analysis/${analysisId}/decisions`, { decisions: next }))
    }

    // deciding auto moves on to the next suggestion, without waiting for the save
    function decide(value) {
        if (!current) return
        const key = current.key
        setDecisions({ ...decisions, [key]: value })
        persist(() => api.put(`/analysis/${analysisId}/decisions/${encodeURIComponent(key)}`, { decision: value }))
        if (count > 1) goTo(active + 1)
    }

    // ignored while typing so it can't hijack the comment box
    useEffect(() => {
        function onKeyDown(e) {
            const tag = (e.target.tagName || "").toLowerCase()
            if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return
            if (e.key === "a" || e.key === "A") decide(true)
            else if (e.key === "d" || e.key === "D") decide(false)
            else if (e.key === "ArrowLeft") goTo(active - 1)
            else if (e.key === "ArrowRight") goTo(active + 1)
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current?.key, count, decisions, actionable])

    // flagged rewrites claim something the original doesn't, so a bulk accept leaves
    // them for the candidate to decide one by one
    function acceptAllUnflagged() {
        const next = { ...decisions }
        for (const { key, item } of actionable) {
            if (!isFlagged(item) && next[key] === undefined) next[key] = true
        }
        save(next)
        const left = actionable.filter(({ key, item }) => isFlagged(item) && next[key] === undefined).length
        if (left) toast(`${left} flagged suggestion${left === 1 ? " was" : "s were"} left for you to review one at a time`)
    }

    if (!count && pending) return <div className="card muted">Suggestions appear here as each batch of bullets is rewritten.</div>
    if (!count) return <div className="card muted">No rewrite-worthy sentences were detected. Header and label lines were skipped.</div>
    const state = decisions[current.key]
    const reviewedCount = actionable.filter(({ key }) => decisions[key] !== undefined).length
    const flags = claimFlags(current.item)
    const note = criticNote(current.item)
    const woven = keywordNote(current.item)
    return <>
        <h2 className="view-title">Review Suggestions</h2>
        {!pending && <GuardSummary result={result} flagged={flaggedCount} />}
        {error && <p className="error-msg">{error}</p>}
        <div className="review-toolbar">
            <span className="review-progress">{reviewedCount} of {count}{pending ? " so far" : ""} reviewed</span>
            <span className="status-chip accepted-chip">{Object.values(decisions).filter(v => v).length} accepted</span>
            <span className="status-chip dismissed-chip">{Object.values(decisions).filter(v => v === false).length} dismissed</span>
            <span className="toolbar-spacer" />
            <span className="kbd-hint"><kbd>A</kbd> accept · <kbd>D</kbd> dismiss · <kbd>←</kbd><kbd>→</kbd> navigate</span>
            <button className="btn-secondary" disabled={pending} title={pending ? "Available once every suggestion is in" : flaggedCount ? "Flagged suggestions are left for you to decide" : undefined} onClick={acceptAllUnflagged}>{flaggedCount ? "Accept all unflagged" : "Accept all"}</button>
            <button className="btn-ghost" onClick={() => save({})}>Clear decisions</button>
        </div>
        <div className="two-col-pdf"><div><span className="section-label">Highlighted Resume</span>{isPdf
            ? <div className="pdf-shell"><Suspense fallback={<p className="muted pdf-viewer-note">Loading the preview…</p>}><PdfViewer file={file} highlights={highlights} activeId={current.key} title="Your resume, with the suggestions highlighted" /></Suspense></div>
            : <div className="card muted">Source preview is available for PDF uploads. Parsed content remains available under Extracted Sections.</div>}</div>
            <div>
                <div className="review-nav">
                    <button className="btn-secondary btn-arrow" onClick={() => goTo(active - 1)} title="Previous suggestion" aria-label="Previous suggestion"><ChevronLeft size={16} /></button>
                    <select
                        className="input-field suggestion-jump"
                        aria-label="Go to a suggestion"
                        value={active}
                        onChange={e => goTo(Number(e.target.value))}
                    >
                        {actionable.map(({ section, item, key }, idx) => (
                            <option key={key} value={idx}>
                                {decisionMark(decisions[key], isFlagged(item))}{idx + 1} of {count} · {section} · {(item.original || "").slice(0, 48)}{(item.original || "").length > 48 ? "…" : ""}
                            </option>
                        ))}
                    </select>
                    <button className="btn-secondary btn-arrow" onClick={() => goTo(active + 1)} title="Next suggestion" aria-label="Next suggestion"><ChevronRight size={16} /></button>
                </div>
                <span className="section-label">Rewrite Decision</span>
                <div className={`suggestion-card ${state === true ? "accepted" : state === false ? "dismissed" : ""}`} key={current.key}>
                    <div className="suggestion-head">
                        <span className="suggestion-title"><span className={`severity-dot ${current.item.severity || "yellow"}`} aria-hidden="true" />{current.section} · <span className="severity-text">{SEVERITY_LABEL[current.item.severity || "yellow"]}</span></span>
                        {state === true && <span className="status-pill status-pill-accepted"><CheckCircle2 size={12} /> Accepted</span>}
                        {state === false && <span className="status-pill status-pill-rejected"><XCircle size={12} /> Rejected</span>}
                        <span className="fw-badge">{current.item.framework_used}</span>
                    </div>
                    <details className="rewrite-details" open>
                        <summary>Original vs. suggested rewrite</summary>
                        {/* word-level: only the words the rewrite actually changed are
                            highlighted - red where the original text was removed or replaced,
                            green where the rewrite added or replaced it */}
                        <DocumentDiff
                            before={current.item.original} after={current.item.rewritten}
                            labelBefore="Original" labelAfter="Suggested rewrite"
                            className={editSupersedes(mentorEdits[current.key]) ? "rewrite-superseded" : ""}
                        />
                        <MentorSuggestionBlock baseText={current.item.rewritten} feedback={mentorEdits[current.key]} viewerRole="candidate" />
                    </details>
                    {flags.length > 0 && <div className="claim-flags" role="note" aria-label="Claim checks">
                        {flags.map(flag => <p className={`claim-flag claim-flag-${flag.kind}`} key={flag.kind}>
                            <AlertTriangle size={14} /><span><b>{flag.title}.</b> {flag.detail}</span>
                        </p>)}
                    </div>}
                    {note && <p className="critic-note"><Info size={13} /> {note}</p>}
                    {woven && <p className="critic-note"><Tag size={13} /> {woven}</p>}
                    <div className="reasoning-row"><Lightbulb size={13} /> {current.item.reasoning}</div>
                </div>
                <div className="decision-actions">
                    <button className={state === false ? "btn-outline-primary btn-accept" : "btn-primary btn-accept"} onClick={() => decide(true)}><Check size={16} /> {flags.length ? "Accept anyway" : "Accept"} &amp; next</button>
                    <button className="btn-ghost" onClick={() => decide(false)}><X size={15} /> Dismiss &amp; next</button>
                </div>
                <AnnotationThread analysisId={analysisId} suggestionKey={current?.key} section={current?.section} viewerRole="candidate" />
            </div>
        </div></>
}
