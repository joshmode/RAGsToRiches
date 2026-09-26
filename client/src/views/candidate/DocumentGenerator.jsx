import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { CheckCircle2, FileEdit, FileOutput, FileText, Loader2, XCircle } from "lucide-react"
import api from "../../api/client"
import { getBlobError, getError } from "../../lib/errors"
import { downloadText } from "../../lib/files"
import { fileSafe } from "../../lib/format"
import { toast } from "../../components/Toast"
import { RevisionTimeline } from "../../components/RevisionTimeline"

function SavedIndicator({ state }) {
    if (state === "idle") return null
    if (state === "error") return <span className="saved-indicator error"><XCircle size={12} /> Save failed</span>
    return <span className={`saved-indicator ${state}`}>{state === "saving" ? <><Loader2 size={12} className="spin-icon" /> Saving…</> : <><CheckCircle2 size={12} /> Saved</>}</span>
}

export function DocumentGenerator({ type, result, provider, localEndpoint, decisions, analysisId, text, setText, onExport, fullName, company, onChangeJobDescription }) {
    const [busy, setBusy] = useState(false)
    const [exportBusy, setExportBusy] = useState(false)
    const [error, setError] = useState("")
    const [mobileTab, setMobileTab] = useState("edit")
    const [saveState, setSaveState] = useState("idle")
    // bumped whenever a new version is recorded, so the revision history re-reads itself
    const [historyKey, setHistoryKey] = useState(0)
    // never reruns the analysis, only the keyword gap and the letter
    const [jdEditorOpen, setJdEditorOpen] = useState(false)
    const [jdDraft, setJdDraft] = useState("")
    const [jdBusy, setJdBusy] = useState(false)
    const title = type === "cv" ? "Tailored CV" : "Cover Letter"
    const documentType = type === "cv" ? "cv" : "cover_letter"
    const firstRun = useRef(true)
    // FULL_NAME_RESUME for the cv, FULL_NAME_COMPANY_NAME for the letter
    const baseFilename = type === "cv"
        ? `${fileSafe(fullName)}_RESUME`
        : `${fileSafe(fullName)}_${company ? fileSafe(company) : "COVER_LETTER"}`

    useEffect(() => {
        if (firstRun.current) { firstRun.current = false; return undefined }
        const id = analysisId || result.analysis_id
        if (!text || !id) return undefined
        setSaveState("saving")
        const t = setTimeout(async () => {
            try {
                await api.post("/generate/save", { analysis_id: id, document_type: documentType, content: text, company })
                setSaveState("saved")
                setHistoryKey(k => k + 1)
            } catch {
                setSaveState("error")
            }
        }, 600)
        return () => clearTimeout(t)
    }, [text])

    async function generate() {
        setBusy(true)
        setError("")
        try {
            const endpoint = type === "cv" ? "/generate/cv" : "/generate/cover-letter"
            const payload = {
                resume_json: result.parsed_resume,
                job_description: result.job_description || "",
                provider,
                local_endpoint: localEndpoint,
                analysis_id: analysisId || result.analysis_id,
            }
            if (type === "cv") {
                payload.rewrite_suggestions = result.rewrites
                payload.rewrite_decisions = decisions
                payload.acc_map = {}
            } else if (company) {
                payload.company = company
            }
            const res = await api.post(endpoint, payload)
            setText(type === "cv" ? res.data.cv_text : res.data.cover_letter_text)
            setHistoryKey(k => k + 1)
        } catch (err) {
            setError(getError(err))
        } finally {
            setBusy(false)
        }
    }

    async function saveJobDescription() {
        setJdBusy(true)
        setError("")
        try {
            const { ok, error: err } = await onChangeJobDescription(jdDraft)
            if (ok) setJdEditorOpen(false)
            else setError(err || "Couldn't regenerate against the new job description.")
        } finally { setJdBusy(false) }
    }

    async function downloadExport(kind) {
        setExportBusy(true)
        try {
            const res = await api.post(`/generate/${kind}`, { text, filename: `${baseFilename}.${kind}` }, { responseType: "blob" })
            const href = URL.createObjectURL(res.data)
            const link = document.createElement("a")
            link.href = href
            link.download = `${baseFilename}.${kind}`
            link.click()
            URL.revokeObjectURL(href)
            onExport?.()
            toast(`${kind.toUpperCase()} downloaded`)
        } catch (err) {
            setError(`Export failed: ${await getBlobError(err)}`)
        } finally {
            setExportBusy(false)
        }
    }

    return <section>
        <h2 className="view-title">Generate {title}</h2>
        <p className="muted">{type === "cv" ? "The generated CV applies accepted rewrites and keeps dismissed original text. Your last generated version is saved automatically." : "Generate a professional cover letter tailored to the job description. Your last generated version is saved automatically."}</p>
        <div className="doc-generate-row">
            <button className="btn-primary generate-btn" disabled={busy} onClick={generate}>{busy ? <><span className="spinner" />Generating — usually under a minute...</> : text ? `Regenerate ${title}` : `Generate ${title}`}</button>
            {onChangeJobDescription && <button className="btn-secondary generate-btn" disabled={busy} onClick={() => { setJdDraft(result.job_description || ""); setJdEditorOpen(o => !o) }}>
                <FileEdit size={14} /> Change Job Description
            </button>}
        </div>
        {jdEditorOpen && <div className="card jd-editor-card">
            <span className="section-label">Job Description</span>
            <p className="muted">Editing this reuses your existing resume analysis - only the Cover Letter and Keyword Gap are regenerated.</p>
            <textarea className="input-field" value={jdDraft} onChange={e => setJdDraft(e.target.value)} placeholder="Paste the job description here" />
            <div className="composer-actions">
                <button className="btn-primary" disabled={jdBusy} onClick={saveJobDescription}>{jdBusy ? <><span className="spinner" /> Regenerating…</> : "Save & Regenerate"}</button>
                <button className="btn-ghost" disabled={jdBusy} onClick={() => setJdEditorOpen(false)}>Cancel</button>
            </div>
        </div>}
        {error && <p className="error-msg">{error}</p>}
        {text && <>
            <div className="split-editor-head">
                <div className="mobile-editor-toggle">
                    <button className={mobileTab === "edit" ? "active" : ""} onClick={() => setMobileTab("edit")}>Edit</button>
                    <button className={mobileTab === "preview" ? "active" : ""} onClick={() => setMobileTab("preview")}>Preview</button>
                </div>
                <SavedIndicator state={saveState} />
            </div>
            <div className="split-editor">
                <div className={`split-editor-pane ${mobileTab === "edit" ? "" : "mobile-hidden"}`}>
                    <h3 className="doc-subhead">Edit Your {title}</h3>
                    <textarea className="input-field doc-editor" value={text} onChange={e => setText(e.target.value)} />
                </div>
                <div className={`split-editor-pane ${mobileTab === "preview" ? "" : "mobile-hidden"}`}>
                    <h3 className="doc-subhead">Preview</h3>
                    <article className="card markdown-preview doc-preview">
                        <ReactMarkdown>{text}</ReactMarkdown>
                    </article>
                </div>
            </div>
            <div className="export-row">
                <button className="btn-dark" disabled={exportBusy} onClick={() => { downloadText(text, `${baseFilename}.md`); onExport?.(); toast("Markdown downloaded") }}><FileText size={15} /> Markdown</button>
                <button className="btn-dark" disabled={exportBusy} onClick={() => downloadExport("docx")}><FileEdit size={15} /> DOCX</button>
                <button className="btn-dark" disabled={exportBusy} onClick={() => downloadExport("pdf")}><FileOutput size={15} /> PDF</button>
            </div>
            {/* every version of this document, who authored it, and what was decided about it -
                the same audit trail the mentor sees, from the same endpoint */}
            {(analysisId || result.analysis_id) && <details className="card">
                <summary>Revision History</summary>
                <RevisionTimeline
                    analysisId={analysisId || result.analysis_id} documentType={documentType}
                    viewerRole="candidate" refreshKey={historyKey}
                />
            </details>}
        </>}
    </section>
}
