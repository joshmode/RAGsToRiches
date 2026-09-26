import { useEffect, useMemo, useState } from "react"
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, X, XCircle } from "lucide-react"
import api from "../../api/client"
import { getError } from "../../lib/errors"
import { fileToBase64 } from "../../lib/files"
import { DocumentDiff } from "../../components/DocumentDiff"
import { MentorSuggestionBlock, editSupersedes } from "../../components/MentorSuggestionBlock"
import { AnnotationThread } from "../../components/AnnotationThread"

function decisionMark(state) {
    if (state === true) return "✓ "
    if (state === false) return "✗ "
    return "• "
}

export function RewriteReview({ result, file, decisions, setDecisions, analysisId, pending = false }) {
    const [activeKey, setActiveKey] = useState(null)
    const [pdfUrl, setPdfUrl] = useState("")
    const [error, setError] = useState("")
    const [mentorEdits, setMentorEdits] = useState({})
    const actionable = useMemo(() => Object.entries(result.rewrites || {}).flatMap(([section, items]) => items.map((item, index) => ({ section, item, index, key: item.id || `${section}_${index}` })).filter(({ item }) => item.framework_used !== "none" && item.framework_used !== "error" && item.original !== item.rewritten)), [result])
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

    useEffect(() => {
        let cancelled = false
        let createdUrl = ""
        if (!file || file.type !== "application/pdf" || !current) {
            setPdfUrl("")
            return undefined
        }
        async function render() {
            let url = ""
            try {
                const items = actionable.map(({ key, item }) => ({
                    id: key,
                    text: item.highlight_text || item.original || "",
                    severity: item.severity || "yellow",
                    reasoning: item.reasoning || "",
                    rewritten: item.rewritten || "",
                }))
                const res = await api.post("/analysis/highlight", { file: await fileToBase64(file), items, active_key: current.key }, { responseType: "blob" })
                const activePage = res.headers["x-active-page"]
                url = URL.createObjectURL(res.data) + (activePage ? `#page=${activePage}` : "")
            } catch {
                url = URL.createObjectURL(file)
            }
            // take thje newer suggestion first
            if (cancelled) {
                URL.revokeObjectURL(url.split("#")[0])
                return
            }
            createdUrl = url
            setPdfUrl(url)
        }
        render()
        return () => {
            cancelled = true
            if (createdUrl) URL.revokeObjectURL(createdUrl.split("#")[0])
        }
    }, [file, current?.key, actionable])

    async function save(next) {
        setDecisions(next)
        setError("")
        if (!analysisId) return
        try {
            await api.post(`/analysis/${analysisId}/decisions`, { decisions: next })
        } catch (err) {
            setError(`Couldn't save your decision: ${getError(err)}`)
        }
    }

    // deciding auto moves on to the next suggestion
    async function decide(value) {
        if (!current) return
        await save({ ...decisions, [current.key]: value })
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

    if (!count && pending) return <div className="card muted">Suggestions appear here as each batch of bullets is rewritten.</div>
    if (!count) return <div className="card muted">No rewrite-worthy sentences were detected. Header and label lines were skipped.</div>
    const state = decisions[current.key]
    const reviewedCount = actionable.filter(({ key }) => decisions[key] !== undefined).length
    return <>
        <h2 className="view-title">Review Suggestions</h2>
        {error && <p className="error-msg">{error}</p>}
        <div className="review-toolbar">
            <span className="review-progress">{reviewedCount} of {count}{pending ? " so far" : ""} reviewed</span>
            <span className="status-chip accepted-chip">{Object.values(decisions).filter(v => v).length} accepted</span>
            <span className="status-chip dismissed-chip">{Object.values(decisions).filter(v => v === false).length} dismissed</span>
            <span className="toolbar-spacer" />
            <span className="kbd-hint"><kbd>A</kbd> accept · <kbd>D</kbd> dismiss · <kbd>←</kbd><kbd>→</kbd> navigate</span>
            <button className="btn-secondary" disabled={pending} title={pending ? "Available once every suggestion is in" : undefined} onClick={() => save(Object.fromEntries(actionable.map(({ key }) => [key, true])))}>Accept all</button>
            <button className="btn-ghost" onClick={() => save({})}>Clear decisions</button>
        </div>
        <div className="two-col-pdf"><div><span className="section-label">Highlighted Resume</span>{pdfUrl ? <div className="pdf-shell"><iframe className="pdf-frame" src={pdfUrl} title="Uploaded resume" /></div> : <div className="card muted">Source preview is available for PDF uploads. Parsed content remains available under Extracted Sections.</div>}</div>
            <div>
                <div className="review-nav">
                    <button className="btn-secondary btn-arrow" onClick={() => goTo(active - 1)} title="Previous suggestion"><ChevronLeft size={16} /></button>
                    <select
                        className="input-field suggestion-jump"
                        value={active}
                        onChange={e => goTo(Number(e.target.value))}
                    >
                        {actionable.map(({ section, item, key }, idx) => (
                            <option key={key} value={idx}>
                                {decisionMark(decisions[key])}{idx + 1} of {count} · {section} · {(item.original || "").slice(0, 48)}{(item.original || "").length > 48 ? "…" : ""}
                            </option>
                        ))}
                    </select>
                    <button className="btn-secondary btn-arrow" onClick={() => goTo(active + 1)} title="Next suggestion"><ChevronRight size={16} /></button>
                </div>
                <span className="section-label">Rewrite Decision</span>
                <div className={`suggestion-card ${state === true ? "accepted" : state === false ? "dismissed" : ""}`} key={current.key}>
                    <div className="suggestion-head">
                        <span className="suggestion-title"><span className={`severity-dot ${current.item.severity || "yellow"}`} />{current.section}</span>
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
                    <div className="reasoning-row"><Lightbulb size={13} /> {current.item.reasoning}</div>
                </div>
                <div className="decision-actions">
                    <button className={state === false ? "btn-outline-primary btn-accept" : "btn-primary btn-accept"} onClick={() => decide(true)}><Check size={16} /> Accept &amp; next</button>
                    <button className="btn-ghost" onClick={() => decide(false)}><X size={15} /> Dismiss &amp; next</button>
                </div>
                <AnnotationThread analysisId={analysisId} suggestionKey={current?.key} section={current?.section} viewerRole="candidate" />
            </div>
        </div></>
}
