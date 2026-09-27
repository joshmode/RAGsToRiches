import { useEffect, useRef, useState } from "react"
import { useDropzone } from "react-dropzone"
import { CheckCircle2, ChevronDown, File as FileIcon, Mail, RotateCw, Sparkles, Trash2 } from "lucide-react"
import { formatFileSize } from "../../lib/format"

// wide segment is the full analysis the caret is cover-letter-only
function AnalyseSplitButton({ disabled, analysing, quickBusy, onAnalyse, onQuickCoverLetter }) {
    const [menuOpen, setMenuOpen] = useState(false)
    const wrapRef = useRef(null)

    useEffect(() => {
        if (!menuOpen) return undefined
        function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false) }
        document.addEventListener("mousedown", onDocClick)
        return () => document.removeEventListener("mousedown", onDocClick)
    }, [menuOpen])

    const busy = analysing || quickBusy
    return <div className="split-btn" ref={wrapRef}>
        <button className="btn-primary split-btn-main" disabled={disabled || busy} onClick={() => { setMenuOpen(false); onAnalyse() }}>
            {analysing ? <><span className="spinner" /> Analysing…</> : <><Sparkles size={16} /> Analyse My Resume</>}
        </button>
        <button
            type="button" className="split-btn-caret" disabled={disabled || busy}
            onClick={() => setMenuOpen(o => !o)} title="More options" aria-label="More generation options" aria-expanded={menuOpen}
        >
            <ChevronDown size={16} />
        </button>
        {menuOpen && <div className="split-btn-menu">
            <button type="button" className="split-btn-menu-item" disabled={disabled || busy} onClick={() => { setMenuOpen(false); onQuickCoverLetter() }}>
                <Mail size={15} />
                <span>
                    {quickBusy ? "Generating cover letter…" : "Generate My Cover Letter"}
                    <small>Fast - skips scoring &amp; rewrite suggestions</small>
                </span>
            </button>
        </div>}
    </div>
}

export function ResumeSetup({ file, setFile, jobDescription, setJobDescription, onAnalyse, onQuickCoverLetter, busy, quickBusy, preview = null }) {
    // analysis.js accepts .doc but this didn't
    const [rejectionError, setRejectionError] = useState("")
    const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
        multiple: false,
        noClick: !!file,
        noKeyboard: !!file,
        accept: {
            "application/pdf": [".pdf"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
            "application/msword": [".doc"],
            "application/vnd.oasis.opendocument.text": [".odt"],
            "text/plain": [".txt", ".md"],
            "application/zip": [".zip"],
        },
        onDrop: (accepted, rejections) => {
            setRejectionError(rejections.length ? "That file type isn't supported. Please upload a PDF, DOCX, DOC, ODT, TXT, MD, or ZIP file." : "")
            if (accepted.length) setFile(accepted[0])
        },
    })

    return <section className="setup-band">
        <div className="card">
            <div className="two-col">
                <div>
                    <span className="section-label">Resume PDF / DOCX / DOC / ODT / TXT / MD / LinkedIn ZIP</span>
                    <div {...getRootProps()} className={`dropzone ${isDragActive ? "active" : ""} ${file ? "has-file" : ""}`}>
                        <input {...getInputProps()} />
                        {file ? (
                            <div className="upload-card">
                                <span className="upload-card-icon"><FileIcon size={20} /></span>
                                <div className="upload-card-info">
                                    <span className="upload-card-name" title={file.name}>{file.name}</span>
                                    <span className="upload-card-meta"><CheckCircle2 size={12} /> {formatFileSize(file.size)}</span>
                                </div>
                                <div className="upload-card-actions">
                                    <button type="button" className="btn-ghost btn-small" onClick={open}><RotateCw size={13} /> Replace</button>
                                    <button type="button" className="upload-card-remove" onClick={() => setFile(null)} title="Remove file" aria-label="Remove file"><Trash2 size={15} /></button>
                                </div>
                            </div>
                        ) : "Drop your resume here, or click to upload"}
                    </div>
                    {rejectionError && <p className="error-msg">{rejectionError}</p>}
                    {file && preview}
                </div>
                <div>
                    <span className="section-label">Job Description <small>(optional for ATS matching)</small></span>
                    <textarea className="input-field" aria-label="Job description" value={jobDescription} onChange={e => setJobDescription(e.target.value)} placeholder="Paste a full job description for keyword matching, or leave blank to improve the CV from rewrite decisions only." />
                </div>
            </div>
            <AnalyseSplitButton disabled={!file} analysing={busy} quickBusy={quickBusy} onAnalyse={onAnalyse} onQuickCoverLetter={onQuickCoverLetter} />
        </div>
    </section>
}
