import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import ReactMarkdown from "react-markdown"
import { Building2, Check, ChevronDown, ChevronUp, PenSquare, RotateCw, X } from "lucide-react"
import api from "../../api/client"
import { getError } from "../../lib/errors"
import { base64ToBlob, fileToBase64 } from "../../lib/files"
import { getScoreCfg } from "../../lib/score"
import { capitalize, formatDateTime, formatShortDate, parseTs } from "../../lib/format"
import { toast } from "../../components/Toast"
import { NotificationBadge } from "../../components/NotificationBadge"
import { DocumentDiff } from "../../components/DocumentDiff"
import { MentorSuggestionBlock, editSupersedes } from "../../components/MentorSuggestionBlock"
import { AnnotationThread } from "../../components/AnnotationThread"
import { FeedbackComposer } from "./FeedbackComposer"
import { CoverLetterWorkspace } from "./CoverLetterWorkspace"

export function CandidateDetail({ candidate, onBack, notifSummary, refreshNotifs }) {
    const [history, setHistory] = useState(null)
    const [analysis, setAnalysis] = useState(null)
    const [diffFrom, setDiffFrom] = useState("")
    const [diffTo, setDiffTo] = useState("")
    const [diff, setDiff] = useState(null)
    const [sent, setSent] = useState([])
    const [error, setError] = useState("")
    // separate workflows not one mixed attempt list
    const [historyTab, setHistoryTab] = useState("resume")
    // starts expanded, opening a resume auto-collapses it
    const [historyOpen, setHistoryOpen] = useState(true)
    // More menu contains comment history / accepted suggestions / cover letters
    const [moreOpen, setMoreOpen] = useState(false)
    const [moreTab, setMoreTab] = useState("comments")
    const [coverLetters, setCoverLetters] = useState(null)
    // original pdf & rewritten preview toggle, directly editable
    const [previewMode, setPreviewMode] = useState("original")
    const [pdfUrl, setPdfUrl] = useState("")
    const [fileB64, setFileB64] = useState("")
    const [previewMd, setPreviewMd] = useState("")
    const [edited, setEdited] = useState("")
    const [dirty, setDirty] = useState(false)
    // per-suggestion Edit pill and a floating composer
    const [composerKey, setComposerKey] = useState(null)
    // same composer keyed by section
    const [sectionEdit, setSectionEdit] = useState(null)
    // a previous suggestion of the mentor's own that the candidate dismissed as starting point
    const [reviseFrom, setReviseFrom] = useState(null)
    // remembers the preview mode in effect before an edit forced it 
    const prevMode = useRef(null)
    // floating compose button for feedback unrelated to any suggestion
    const [composeOpen, setComposeOpen] = useState(false)

    async function load() {
        try {
            const [historyRes, sentRes] = await Promise.all([
                api.get(`/mentor/candidates/${candidate.id}/history`),
                api.get(`/mentor/feedback?candidate_id=${candidate.id}`),
            ])
            setHistory(historyRes.data)
            setSent(sentRes.data)
        } catch (err) { setError(getError(err)) }
    }
    useEffect(() => { load() }, [candidate.id])

    async function openAnalysis(id) {
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/analyses/${id}`)
            setAnalysis(res.data)
            setDiff(null)
            setHistoryOpen(false)
            setPreviewMode("original")
            setDirty(false)
            setComposerKey(null)
            setSectionEdit(null)
            prevMode.current = null
            // viewing clears unread state on the mentor side too
            api.post("/notifications/mark-read", { analysis_id: id }).then(refreshNotifs).catch(() => {})
        } catch (err) { setError(getError(err)) }
    }

    // forces the pdf back to original so the auto-jump shows the right page
    function startEdit(itemId, reuse = null) {
        if (composerKey === itemId && !reuse) { cancelEdit(); return }
        setSectionEdit(null)
        setReviseFrom(reuse)
        if (prevMode.current === null) prevMode.current = previewMode
        setPreviewMode("original")
        setComposerKey(itemId)
    }
    function startSectionEdit(sectionName, reuse = null) {
        if (sectionEdit === sectionName && !reuse) { cancelEdit(); return }
        setComposerKey(null)
        setReviseFrom(reuse)
        if (prevMode.current === null) prevMode.current = previewMode
        setPreviewMode("original")
        setSectionEdit(sectionName)
    }
    function cancelEdit() {
        setComposerKey(null)
        setSectionEdit(null)
        setReviseFrom(null)
        if (prevMode.current !== null) {
            setPreviewMode(prevMode.current)
            prevMode.current = null
        }
    }

    // raw bytes once per analysis plus the preview markdown same as the candidate sees
    useEffect(() => {
        if (!analysis) { setFileB64(""); setPreviewMd(""); setEdited(""); return undefined }
        let cancelled = false
        async function loadFile() {
            try {
                const fileRes = await api.get(`/mentor/candidates/${candidate.id}/resumes/${analysis.resume_id}/file`, { responseType: "blob" })
                const b64 = await fileToBase64(fileRes.data)
                if (!cancelled) setFileB64(b64)
            } catch { if (!cancelled) setFileB64("") }
        }
        async function loadPreview() {
            try {
                const res = await api.get(`/mentor/candidates/${candidate.id}/analyses/${analysis.id}/preview`)
                if (!cancelled) { setPreviewMd(res.data.markdown); setEdited(res.data.markdown) }
            } catch { if (!cancelled) { setPreviewMd(""); setEdited("") } }
        }
        loadFile()
        loadPreview()
        return () => { cancelled = true }
    }, [analysis?.id, candidate.id])

    // rehighlights the cached bytes on any edit
    const sectionEditActiveKey = sectionEdit ? (analysis?.results?.rewrites?.[sectionEdit]?.[0]?.id || "") : ""
    const highlightActiveKey = composerKey || sectionEditActiveKey
    useEffect(() => {
        if (!analysis || !fileB64) {
            setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev.split("#")[0]); return "" })
            return undefined
        }
        let cancelled = false
        let createdUrl = ""
        const items = Object.entries(analysis.results?.rewrites || {}).flatMap(([, list]) =>
            list.filter(it => it.framework_used !== "none" && it.framework_used !== "error").map(it => ({
                id: it.id, text: it.highlight_text || it.original || "", severity: it.severity || "yellow",
                reasoning: it.reasoning || "", rewritten: it.rewritten || "",
            }))
        )
        async function render() {
            try {
                const res = await api.post("/analysis/highlight", { file: fileB64, items, active_key: highlightActiveKey }, { responseType: "blob" })
                if (cancelled) return
                const activePage = res.headers["x-active-page"]
                createdUrl = URL.createObjectURL(res.data) + (highlightActiveKey && activePage ? `#page=${activePage}` : "")
                setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev.split("#")[0]); return createdUrl })
            } catch {
                if (cancelled) return
                // highlighting can fail for reasons unrelated to the file
                const isPdf = atob(fileB64.slice(0, 8)).startsWith("%PDF")
                if (isPdf) {
                    createdUrl = URL.createObjectURL(base64ToBlob(fileB64))
                    setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev.split("#")[0]); return createdUrl })
                } else {
                    setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev.split("#")[0]); return "" })
                }
            }
        }
        render()
        return () => {
            cancelled = true
            // only if it resolved after cancellation, before setPdfUrl ran for this url
            if (createdUrl) URL.revokeObjectURL(createdUrl.split("#")[0])
        }
    }, [analysis?.id, fileB64, highlightActiveKey])

    async function runDiff() {
        if (!diffFrom || !diffTo) return
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/diff?from=${diffFrom}&to=${diffTo}`)
            setDiff(res.data)
            setAnalysis(null)
            // same cleanup openAnalysis() does keeps the fab hidden until one is reopened
            setComposerKey(null)
            setSectionEdit(null)
            prevMode.current = null
        } catch (err) { setError(getError(err)) }
    }

    // Done sends the edits on as a suggestion
    async function doneEditing() {
        if (!dirty) { setPreviewMode("original"); return }
        try {
            await api.post("/mentor/feedback", {
                candidate_id: candidate.id,
                analysis_id: analysis.id,
                suggestion_key: `preview:${analysis.id}`,
                feedback_type: "edit",
                section: "Full Resume Preview",
                original_text: previewMd,
                suggested_text: edited,
                comment: "Mentor-edited rewritten preview",
            })
            setPreviewMd(edited)
            setDirty(false)
            setPreviewMode("original")
            toast("Suggested edits sent to candidate")
            await load()
        } catch (err) { setError(getError(err)) }
    }

    function discardEditing() {
        setEdited(previewMd)
        setDirty(false)
        setPreviewMode("original")
    }

    async function openMoreTab(tab) {
        setMoreOpen(true)
        setMoreTab(tab)
        if (tab === "coverletters" && !coverLetters) {
            try { setCoverLetters((await api.get(`/mentor/candidates/${candidate.id}/cover-letters`)).data) } catch (err) { setError(getError(err)) }
        }
    }

    // latest per target, so the workspace shows what was proposed and what came of it
    const sentByKey = useMemo(() => {
        const map = {}
        for (const f of sent) {
            if (!analysis || f.analysis_id !== analysis.id || !f.suggestion_key) continue
            const prev = map[f.suggestion_key]
            const at = parseTs(f.updated_at || f.created_at)
            const prevAt = prev && parseTs(prev.updated_at || prev.created_at)
            // second-resolution timestamps tie, fall back to id or the older one wins
            if (!prev || at > prevAt || (at === prevAt && f.id > prev.id)) map[f.suggestion_key] = f
        }
        return map
    }, [sent, analysis?.id])

    const allAnalyses = history?.analyses || []
    const analyses = allAnalyses.filter(a => a.attempt_type !== "cover_letter_only")
    const clAtts = allAnalyses.filter(a => a.attempt_type === "cover_letter_only")
    const candidateBadges = notifSummary?.by_candidate_and_type?.[candidate.id] || {}
    const rewrites = analysis?.results?.rewrites || {}
    const decisions = analysis?.results?.decisions || {}
    const sections = analysis?.results?.sections || {}
    const acceptedItems = Object.entries(rewrites).flatMap(([section, items]) => items.filter(it => decisions[it.id] === true).map(it => ({ ...it, section })))
    const editingItem = composerKey
        ? Object.entries(rewrites).flatMap(([section, items]) => items.map(it => ({ ...it, section }))).find(it => it.id === composerKey)
        : null

    // current attempt up front, older behind a disclosure same as the candidate's inbox
    const sentCurrentAttempt = sent.reduce((max, f) => Math.max(max, f.attempt_number || 0), 0)
    const sentCurrent = sent.filter(f => f.attempt_number === sentCurrentAttempt)
    const sentPrevious = sent.filter(f => f.attempt_number !== sentCurrentAttempt).sort((a, b) => parseTs(a.created_at) - parseTs(b.created_at))

    function renderSentItem(f) {
        return <div className={`card feedback-item ${f.status}`} key={f.id}>
            <div className="feedback-meta">
                <span className="fw-badge">{capitalize(f.feedback_type)}</span>
                {f.section && <span className="status-chip">{f.section}</span>}
                <span className={`status-chip status-${f.status}`}>{capitalize(f.status)}</span>
                {f.attempt_number && <span className="feedback-attempt-meta">Attempt #{f.attempt_number} &bull; {formatShortDate(f.created_at)}</span>}
            </div>
            {f.feedback_type === "edit" && <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{f.original_text}</p></div><div className="rewrite-pane after"><span className="pane-label">Suggested</span><p className="rewrite-text">{f.suggested_text}</p></div></div>}
            {f.comment && <p className="feedback-comment">{f.comment}</p>}
        </div>
    }

    return <section className="mentor-workspace">
        <div className="detail-head">
            <button className="btn-secondary" onClick={onBack}>← All candidates</button>
            <h3 className="detail-title">{candidate.name}</h3>
            {/* More sits beside All Candidates, not under the pdf */}
            {historyTab === "resume" && analysis && !diff && <button className="btn-secondary btn-small mentor-more-toggle-btn" onClick={() => setMoreOpen(!moreOpen)}>{moreOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} More</button>}
        </div>
        {error && <p className="warning-strip">{error}</p>}
        <div className="history-type-toggle">
            <button className={historyTab === "resume" ? "active" : ""} onClick={() => setHistoryTab("resume")}>Resume Analysis<NotificationBadge count={candidateBadges.resume_analysis} /></button>
            <button className={historyTab === "cover_letter" ? "active" : ""} onClick={() => { cancelEdit(); setMoreOpen(false); setHistoryTab("cover_letter") }}>Cover Letters<NotificationBadge count={candidateBadges.cover_letter_only} /></button>
        </div>
        {historyTab === "resume" && analysis && !diff && moreOpen && <div className="card mentor-more-panel">
            <div className="mentor-more-tabs">
                <button className={moreTab === "comments" ? "active" : ""} onClick={() => openMoreTab("comments")}>Comment History</button>
                <button className={moreTab === "accepted" ? "active" : ""} onClick={() => openMoreTab("accepted")}>Accepted AI Suggestions</button>
                <button className={moreTab === "coverletters" ? "active" : ""} onClick={() => openMoreTab("coverletters")}>Cover Letters</button>
            </div>

            {moreTab === "comments" && <>
                <span className="section-label">Current Attempt</span>
                <div className="feedback-list">
                    {sentCurrent.length ? sentCurrent.map(renderSentItem) : <p className="muted">No feedback sent yet for the current attempt.</p>}
                </div>
                {sentPrevious.length > 0 && <details className="card previous-feedback">
                    <summary>Previous Attempts ({sentPrevious.length})</summary>
                    <div className="feedback-list">{sentPrevious.map(renderSentItem)}</div>
                </details>}
            </>}

            {moreTab === "accepted" && (acceptedItems.length ? acceptedItems.map(item => (
                <div className="card mentor-suggestion" key={item.id}>
                    <span className="status-chip">{item.section}</span>
                    <div className="rewrite-grid"><div className="rewrite-pane before"><span className="pane-label">Original</span><p className="rewrite-text">{item.original}</p></div><div className="rewrite-pane after"><span className="pane-label">Accepted rewrite</span><p className="rewrite-text">{item.rewritten}</p></div></div>
                </div>
            )) : <p className="muted">No suggestions accepted yet.</p>)}

            {moreTab === "coverletters" && (coverLetters == null ? <p className="muted">Loading…</p> : coverLetters.length ? coverLetters.map(cl => (
                <div className="card" key={cl.id}>
                    <div className="feedback-meta">
                        <span className="fw-badge"><Building2 size={12} /> {cl.company || "Company not detected"}</span>
                        <span className="status-chip">Attempt #{cl.attempt_number || "—"}</span>
                        <small className="muted">{formatShortDate(cl.created_at)}</small>
                    </div>
                    <pre className="section-pre">{cl.content}</pre>
                </div>
            )) : <p className="muted">No cover letters generated yet.</p>)}
        </div>}
        {historyTab === "cover_letter" && <CoverLetterWorkspace candidate={candidate} attempts={clAtts} sent={sent} onSent={load} unreadById={notifSummary?.by_analysis_id} />}
        {historyTab === "resume" && <div className="two-col">
            <div>
                <details className="card mentor-history-card" open={historyOpen} onToggle={e => setHistoryOpen(e.currentTarget.open)}>
                    <summary>Analysis History {historyOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</summary>
                    <div className="mentor-history-table-wrap"><table><thead><tr><th>Date</th><th>Score</th><th>Model</th><th /></tr></thead><tbody>
                        {analyses.map(a => <tr key={a.id} className={`${analysis?.id === a.id ? "mentor-history-row-open" : ""} ${notifSummary?.by_analysis_id?.[a.id] ? "history-row-unread-mentor" : ""}`}>
                            <td>{formatDateTime(a.created_at)}</td>
                            <td style={{ color: getScoreCfg(a.score_total).color, fontWeight: 700 }}>{a.score_total}</td>
                            <td>{a.provider}{a.model ? ` / ${a.model}` : ""}</td>
                            <td><button className="btn-secondary btn-small" onClick={() => openAnalysis(a.id)}>Open</button></td>
                        </tr>)}
                        {!analyses.length && <tr><td colSpan={4} className="muted">No analyses yet.</td></tr>}
                    </tbody></table></div>
                </details>
                <span className="section-label">Compare Revisions</span>
                <div className="card">
                    <div className="composer-row">
                        <select className="input-field" value={diffFrom} onChange={e => setDiffFrom(e.target.value)}>
                            <option value="">Before…</option>
                            {analyses.map(a => <option key={a.id} value={a.id}>#{a.id} · {formatDateTime(a.created_at)} · {a.score_total}/100</option>)}
                        </select>
                        <select className="input-field" value={diffTo} onChange={e => setDiffTo(e.target.value)}>
                            <option value="">After…</option>
                            {analyses.map(a => <option key={a.id} value={a.id}>#{a.id} · {formatDateTime(a.created_at)} · {a.score_total}/100</option>)}
                        </select>
                        <button className="btn-primary" onClick={runDiff} disabled={!diffFrom || !diffTo || diffFrom === diffTo}>Compare</button>
                    </div>
                </div>

                {/* the main workspace */}
                <span className="section-label">Extracted Sections</span>
                {!analysis && <div className="card muted">Open an analysis above to see extracted sections and suggestions.</div>}
                {analysis && !Object.keys(sections).length && <div className="card muted">No sections were extracted for this analysis.</div>}
                {analysis && Object.entries(sections).map(([name, lines], idx) => {
                    const sectionText = lines.join("\n")
                    const sectionEdit = sentByKey[`section_edit:${analysis.id}:${name}`]
                    return <details className="card" key={name} open={idx === 0}>
                        <summary>{name}</summary>
                        {/* a second editing level */}
                        <button className="pill edit-section-pill" onClick={() => startSectionEdit(name)}><PenSquare size={12} /> {sectionEdit === name ? "Cancel Section Edit" : "Edit Section"}</button>
                        {/* the extracted section is struck through while the mentor's rewrite is
                            the live proposal, and restored the moment it is dismissed */}
                        <pre className={`section-pre ${editSupersedes(sectionEdit) ? "section-pre-superseded" : ""}`}>{sectionText}</pre>
                        {sectionEdit && <>
                            <MentorSuggestionBlock baseText={sectionText} feedback={sectionEdit} viewerRole="mentor" />
                            {sectionEdit.status === "dismissed" && <button className="pill suggest-edit-pill" onClick={() => startSectionEdit(name, sectionEdit)}>
                                <RotateCw size={12} /> Revise &amp; resend
                            </button>}
                        </>}
                        {(rewrites[name] || []).filter(item => item.framework_used !== "none" && item.framework_used !== "error").map(item => {
                            const bulletEdit = sentByKey[item.id]
                            return <div className="mentor-suggestion" key={item.id}>
                                <div className="feedback-meta">
                                    <span className={`severity-dot ${item.severity || "yellow"}`} />
                                    <span className={`status-chip ${decisions[item.id] === true ? "status-accepted" : decisions[item.id] === false ? "status-dismissed" : ""}`}>{decisions[item.id] === true ? "Accepted" : decisions[item.id] === false ? "Dismissed" : "Undecided"}</span>
                                    <button className="pill suggest-edit-pill" onClick={() => startEdit(item.id)}><PenSquare size={12} /> {composerKey === item.id ? "Cancel Edit" : "Edit"}</button>
                                    {bulletEdit?.status === "dismissed" && <button className="pill suggest-edit-pill" onClick={() => startEdit(item.id, bulletEdit)}>
                                        <RotateCw size={12} /> Revise &amp; resend
                                    </button>}
                                </div>
                                <DocumentDiff
                                    before={item.original} after={item.rewritten}
                                    labelBefore="Original" labelAfter="AI rewrite"
                                    className={editSupersedes(bulletEdit) ? "rewrite-superseded" : ""}
                                />
                                <MentorSuggestionBlock baseText={item.rewritten} feedback={bulletEdit} viewerRole="mentor" />
                                <AnnotationThread analysisId={analysis.id} suggestionKey={item.id} section={name} viewerRole="mentor" />
                            </div>
                        })}
                    </details>
                })}
            </div>
            <div>
                {diff && <>
                    <span className="section-label">Resume Diff · #{diff.from.id} ({diff.from.score}/100) → #{diff.to.id} ({diff.to.score}/100)</span>
                    {diff.sections.filter(sec => sec.before !== sec.after).map(sec => (
                        <details className="card" key={sec.section} open>
                            <summary>{sec.section}</summary>
                            <DocumentDiff before={sec.before} after={sec.after} labelBefore="Earlier revision" labelAfter="Later revision" />
                        </details>
                    ))}
                    {!diff.sections.some(sec => sec.before !== sec.after) && <p className="muted">No differences between these two revisions.</p>}
                </>}
                {analysis && !diff && <>
                    {/* header + toggle + viewer stay pinned while the sections scroll */}
                    <div className="mentor-pdf-sticky">
                        <span className="section-label">Analysis #{analysis.id} · {analysis.score}/100 · {formatDateTime(analysis.created_at)}</span>
                        <div className="mentor-preview-toggle">
                            <button className={previewMode === "original" ? "active" : ""} onClick={() => setPreviewMode("original")}>Original PDF</button>
                            <button className={previewMode === "rewritten" ? "active" : ""} onClick={() => setPreviewMode("rewritten")}>Rewritten Preview</button>
                        </div>
                        {previewMode === "original" && (
                            pdfUrl ? <div className="pdf-shell"><iframe className="pdf-frame" src={pdfUrl} title="Candidate resume" /></div> : <div className="card muted">Source preview is available for PDF uploads only.</div>
                        )}
                    </div>
                    {previewMode === "rewritten" && <>
                        <textarea className="input-field doc-editor mentor-preview-editor" value={edited} onChange={e => { setEdited(e.target.value); setDirty(e.target.value !== previewMd) }} />
                        <article className="card markdown-preview doc-preview"><ReactMarkdown>{edited}</ReactMarkdown></article>
                        <div className="mentor-preview-actions">
                            <button className="btn-primary" onClick={doneEditing} disabled={!dirty}><Check size={15} /> Done</button>
                            <button className="btn-ghost" onClick={discardEditing} disabled={!dirty}>Discard Without Saving</button>
                        </div>
                    </>}
                </>}
                {!analysis && !diff && <div className="card muted">Open an analysis or compare two revisions to see details here.</div>}
            </div>
        </div>}

        {historyTab === "resume" && !composerKey && !sectionEdit && <button className="mentor-compose-fab" onClick={() => setComposeOpen(true)} title="Compose general feedback"><PenSquare size={20} /></button>}
        {historyTab === "resume" && composeOpen && createPortal(<div className="modal-overlay" onClick={() => setComposeOpen(false)}>
            <div className="modal-panel" onClick={e => e.stopPropagation()}>
                <div className="modal-head">
                    <h3 className="modal-title">General Feedback</h3>
                    <button className="btn-ghost modal-close" onClick={() => setComposeOpen(false)} title="Close"><X size={18} /></button>
                </div>
                <FeedbackComposer candidateId={candidate.id} analysisId={analysis?.id} prefill={null} onSent={() => { load(); setComposeOpen(false) }} />
            </div>
        </div>, document.body)}

        {/* floating rather than inline */}
        {composerKey && editingItem && createPortal(<div className="floating-composer">
            <div className="floating-composer-head">
                <h4>Edit suggestion · {editingItem.section}</h4>
                <button className="btn-ghost modal-close" onClick={cancelEdit} title="Close"><X size={16} /></button>
            </div>
            <FeedbackComposer
                candidateId={candidate.id} analysisId={analysis.id}
                prefill={{
                    type: "edit", section: editingItem.section, original: editingItem.original,
                    key: editingItem.id, suggested: reviseFrom?.suggested_text || "", seed: reviseFrom?.id || 0,
                }}
                onSent={(text) => {
                    const item = editingItem
                    cancelEdit()
                    load()
                    if (text) setEdited(prev => prev.includes(item.rewritten) ? prev.replace(item.rewritten, text) : prev.includes(item.original) ? prev.replace(item.original, text) : prev)
                }}
            />
        </div>, document.body)}

        {/* the other editing level */}
        {sectionEdit && createPortal(<div className="floating-composer">
            <div className="floating-composer-head">
                <h4>Edit section · {sectionEdit}</h4>
                <button className="btn-ghost modal-close" onClick={cancelEdit} title="Close"><X size={16} /></button>
            </div>
            <FeedbackComposer
                candidateId={candidate.id} analysisId={analysis.id}
                prefill={{
                    type: "section_edit", section: sectionEdit,
                    original: (sections[sectionEdit] || []).join("\n"),
                    key: `section_edit:${analysis.id}:${sectionEdit}`,
                    suggested: reviseFrom?.suggested_text || "", seed: reviseFrom?.id || 0,
                }}
                onSent={() => { cancelEdit(); load() }}
            />
        </div>, document.body)}
    </section>
}
