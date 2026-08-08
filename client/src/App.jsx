import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useDropzone } from "react-dropzone"
import ReactMarkdown from "react-markdown"
import {
    MessageSquareText, SearchCheck, FileText, FileEdit, Mail, Briefcase, BarChart3, Users,
    FileOutput, PanelLeftClose, PanelLeftOpen, IdCard, TrendingUp,
    TrendingDown, Check, X, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, UploadCloud, Sparkles,
    ClipboardCheck, Download, CheckCircle2, XCircle, LogIn, LogOut, Loader2, KeyRound, Lightbulb,
    File as FileIcon, RotateCw, Trash2, Clock, PenSquare, Building2, Ban, History,
} from "lucide-react"
import api from "./api/client"
import { useAuth } from "./context/AuthContext"
import { DocumentDiff, InlineDiff } from "./DocumentDiff"

// model is fixed per provider server-side now UI only picks the provider
const PROVIDER_OPTIONS = [
    { key: "default", label: "Default (Free)", byok: false },
    { key: "gemini", label: "Gemini (Own Key)", byok: true },
    { key: "claude", label: "Claude (Own Key)", byok: true },
    { key: "chatgpt", label: "ChatGPT (Own Key)", byok: true },
    { key: "local", label: "Local LLM", byok: false },
]

// core workflow only the rest lives behind More instead of competing for space
const ALWAYS_NAV = [
    { key: "Suggestions", icon: MessageSquareText },
    { key: "Keyword Gap", icon: SearchCheck },
    { key: "Tailored CV", icon: FileEdit },
    { key: "Cover Letter", icon: Mail },
    { key: "Mentor Feedback", icon: Users },
]
const MORE_NAV = [
    { key: "Insights", icon: BarChart3 },
    { key: "Job Matching", icon: Briefcase },
    { key: "Extracted Sections", icon: FileText },
    { key: "Attempt History", icon: History },
]

// ext -> mime, for rebuilding a File from raw bytes
const RESUME_EXT_MIME = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    odt: "application/vnd.oasis.opendocument.text",
    txt: "text/plain",
    md: "text/plain",
    zip: "application/zip",
}
const NAV_ITEMS = [...ALWAYS_NAV, ...MORE_NAV].map(i => i.key)

const PIPELINE_STEPS = [
    { key: "upload", label: "Upload Resume", icon: UploadCloud },
    { key: "analyse", label: "AI Analysis", icon: Sparkles },
    { key: "review", label: "Review Suggestions", icon: ClipboardCheck },
    { key: "generate", label: "Generate Tailored Resume", icon: FileOutput },
    { key: "export", label: "Export", icon: Download },
]

function formatDuration(ms) {
    const totalSeconds = ms / 1000
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`
    // round the whole thing first or 119.6s comes out "1 min 60 s"
    const rounded = Math.round(totalSeconds)
    const minutes = Math.floor(rounded / 60)
    const seconds = rounded % 60
    return `${minutes} min ${seconds} s`
}

function getScoreCfg(score) {
    if (score >= 70) return { color: "#3F8F6B", label: "Strong" }
    if (score >= 50) return { color: "#B8853B", label: "Needs work" }
    return { color: "#BC5B57", label: "Needs improvement" }
}

// colour plus a label for heatmaop
function heatmapQuality(quality) {
    const q = quality || 0
    if (q >= 85) return { label: "Excellent", color: "#2F7D5C" }
    if (q >= 65) return { label: "Good", color: "#6FA37A" }
    if (q >= 40) return { label: "Fair", color: "#C17F3A" }
    return { label: "Needs Work", color: "#BC5B57" }
}

// traffic lights 
function heatColor(quality) {
    const normalised = Math.max(0, Math.min(100, ((quality || 0) - 33) / 0.67))
    const hue = Math.round(normalised * 1.2)
    return `hsl(${hue}, 70%, 45%)`
}

function getError(err) {
    return err.response?.data?.error || err.message || "Something went wrong."
}

// module-level pub/sub so anything can fire a toast
const toastListeners = new Set()
function toast(message, kind = "success") {
    const entry = { id: `${Date.now()}_${Math.random()}`, message, kind }
    toastListeners.forEach(fn => fn(entry))
}
function ToastHost() {
    const [toasts, setToasts] = useState([])
    useEffect(() => {
        function add(entry) {
            setToasts(prev => [...prev, entry])
            setTimeout(() => setToasts(prev => prev.filter(t => t.id !== entry.id)), 3200)
        }
        toastListeners.add(add)
        return () => toastListeners.delete(add)
    }, [])
    if (!toasts.length) return null
    return <div className="toast-host">{toasts.map(t => (
        <div className={`toast toast-${t.kind}`} key={t.id}>
            {t.kind === "error" ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
            {t.message}
        </div>
    ))}</div>
}

// blob requests get errors back as a blob too, decode for the real message
async function getBlobError(err) {
    const data = err.response?.data
    if (data instanceof Blob && data.type.includes("json")) {
        try {
            return JSON.parse(await data.text()).error || getError(err)
        } catch {
            return getError(err)
        }
    }
    return getError(err)
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1])
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
    })
}

function base64ToBlob(b64, type = "application/pdf") {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type })
}

const NOTIFICATION_SUMMARY_DEFAULT = { unread_total: 0, by_attempt_type: {}, by_analysis_id: {}, by_candidate_id: {}, by_candidate_and_type: {} }

// every badge off one endpoint no websocket 
function useNotifSummary(enabled) {
    const [summary, setSummary] = useState(NOTIFICATION_SUMMARY_DEFAULT)
    function refresh() {
        if (!enabled) return
        api.get("/notifications/summary").then(res => setSummary(res.data)).catch(() => {})
    }
    useEffect(() => {
        if (!enabled) { setSummary(NOTIFICATION_SUMMARY_DEFAULT); return undefined }
        refresh()
        const id = setInterval(refresh, 30000)
        return () => clearInterval(id)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled])
    return [summary, refresh]
}

function pollJob(jobId) {
    const deadline = Date.now() + 10 * 60 * 1000
    return new Promise((resolve, reject) => {
        let attempts = 0
        const poll = async () => {
            try {
                const response = await api.get(`/analysis/jobs/${jobId}`)
                if (response.data.status === "completed") return resolve(response.data.results)
                if (response.data.status === "failed") return reject(new Error(response.data.error || "Analysis failed."))
                if (Date.now() >= deadline) return reject(new Error("Analysis timed out."))
                attempts += 1
                // poll fast at first (batched analysis is usually quick), then back off
                const delay = attempts < 5 ? 1000 : attempts < 15 ? 2000 : 4000
                window.setTimeout(poll, delay)
            } catch (err) {
                reject(err)
            }
        }
        poll()
    })
}

function AuthPage() {
    const { login, register, continueAsGuest } = useAuth()
    const [tab, setTab] = useState("login")
    const [form, setForm] = useState({ username: "", password: "", display_name: "", email: "", confirm: "", role: "candidate" })
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)

    function update(key, value) {
        setForm({ ...form, [key]: value })
    }

    async function submit(e) {
        e.preventDefault()
        setError("")
        if (tab === "register" && form.password !== form.confirm) {
            setError("Passwords do not match.")
            return
        }
        setBusy(true)
        try {
            if (tab === "login") await login(form.username, form.password)
            else await register(form.username, form.password, form.display_name, form.role, form.email)
        } catch (err) {
            setError(getError(err))
        } finally {
            setBusy(false)
        }
    }

    async function guestContinue() {
        setError("")
        setBusy(true)
        try {
            await continueAsGuest()
        } catch (err) {
            setError(getError(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <main className="app-container auth-page">
            <section className="auth-card">
                <h2>Welcome to RAGsToRiches</h2>
                <p className="auth-sub">Sign in or create an account to get started.</p>
                <div className="auth-tabs">
                    <button className={`auth-tab ${tab === "login" ? "active" : ""}`} onClick={() => { setTab("login"); setError("") }}>Sign In</button>
                    <button className={`auth-tab ${tab === "register" ? "active" : ""}`} onClick={() => { setTab("register"); setError("") }}>Register</button>
                </div>
                <form onSubmit={submit}>
                    {tab === "register" && <>
                        <Field label="Display Name" value={form.display_name} onChange={v => update("display_name", v)} required />
                        <Field label="Email (optional)" type="email" value={form.email} onChange={v => update("email", v)} />
                    </>}
                    <Field label="Username" value={form.username} onChange={v => update("username", v)} required />
                    <Field label="Password" type="password" value={form.password} onChange={v => update("password", v)} required />
                    {tab === "register" && <>
                        <Field label="Confirm Password" type="password" value={form.confirm} onChange={v => update("confirm", v)} required />
                        <label className="form-group">I am a...
                            <select className="input-field" value={form.role} onChange={e => update("role", e.target.value)}>
                                <option value="candidate">Candidate</option>
                                <option value="mentor">Mentor</option>
                            </select>
                        </label>
                    </>}
                    {error && <p className="error-msg">{error}</p>}
                    <button className="btn-primary full-width auth-submit-btn" disabled={busy}>{busy ? "Please wait..." : tab === "login" ? "Sign In" : "Create Account"}</button>
                </form>
                <div className="auth-guest-row">
                    <button type="button" className="auth-guest-link" disabled={busy} onClick={guestContinue}>Continue without an account</button>
                    <p className="muted auth-guest-note">Guest sessions aren't tied to an account — you won't be able to sign back in to this session, and any uploaded resumes and analysis are automatically deleted from our servers within 24 hours.</p>
                </div>
            </section>
        </main>
    )
}

function Field({ label, type = "text", value, onChange, required }) {
    return <label className="form-group">{label}<input className="input-field" type={type} value={value} onChange={e => onChange(e.target.value)} required={required} /></label>
}

function Hero() {
    return <section className="hero-wrap">
        <div className="hero-eyebrow">Resume intelligence, reimagined</div>
        <h1 className="hero-title"><span className="title-prefix">RagsToRiches:</span><br /><span className="accent">Smarter resumes, smarter opportunities.</span></h1>
        <p className="hero-sub">Review rewrite suggestions against the uploaded resume, apply the changes you trust, then generate a CV from those decisions with or without a job description.</p>
    </section>
}

// one sign-in/out control
function AuthBar({ user, onLogout }) {
    return <div className="auth-bar">
        {user ? <>
            <span className="auth-bar-status">{user.is_guest ? "Browsing as " : "Signed in as "}<b>{user.display_name}</b></span>
            <button className="btn-ghost btn-small" onClick={onLogout}>{user.is_guest ? <><LogIn size={13} /> Sign In</> : <><LogOut size={13} /> Sign Out</>}</button>
        </> : <span className="auth-bar-status">Sign In</span>}
    </div>
}

// fixed, never auto-hides 
function TopNav({ view, setView, badges = {} }) {
    const [moreOpen, setMoreOpen] = useState(false)

    return <nav className="top-nav">
        <div className="nav-row">
            {/* .nav-tabs is its own flex:1 centered container, kept to a single non-wrapping
                row (overflow scrolls instead of wrapping) so the always-visible tabs stay
                centred and the bar never grows a second row on its own */}
            <div className="nav-tabs">
                {ALWAYS_NAV.map(({ key, icon: Icon }) => (
                    <button className={`nav-pill ${view === key ? "active" : ""}`} key={key} onClick={() => setView(key)}>
                        <Icon size={14} /><span>{key}</span><NotificationBadge count={badges[key]} />
                    </button>
                ))}
            </div>
            <button className={`nav-more-toggle ${moreOpen ? "open" : ""}`} onClick={() => setMoreOpen(!moreOpen)} title={moreOpen ? "Collapse" : "More"}>
                <ChevronDown size={16} />
            </button>
        </div>
        <div className={`nav-more-row ${moreOpen ? "open" : ""}`}>
            <span className="nav-more-label">More</span>
            {MORE_NAV.map(({ key, icon: Icon }) => (
                <button className={`nav-pill ${view === key ? "active" : ""}`} key={key} onClick={() => setView(key)} tabIndex={moreOpen ? 0 : -1}>
                    <Icon size={14} /><span>{key}</span><NotificationBadge count={badges[key]} />
                </button>
            ))}
        </div>
    </nav>
}

function PipelineStepper({ file, busy, result, docs, exported }) {
    let activeIndex = 0
    if (file) activeIndex = 1
    if (result) activeIndex = 2
    if (docs.cv || docs.cover_letter) activeIndex = 3
    if (exported) activeIndex = 4
    if (busy) activeIndex = Math.min(activeIndex, 1)

    return <div className="pipeline-stepper">
        {PIPELINE_STEPS.map((step, idx) => {
            const state = idx < activeIndex ? "done" : idx === activeIndex ? "active" : "upcoming"
            const Icon = step.icon
            return <div className={`pipeline-step ${state}`} key={step.key}>
                <span className="pipeline-step-icon">{state === "done" ? <Check size={13} /> : idx === activeIndex && busy ? <Loader2 size={13} className="spin-icon" /> : <Icon size={13} />}</span>
                <span className="pipeline-step-label">{step.label}</span>
                {idx < PIPELINE_STEPS.length - 1 && <span className="pipeline-step-connector" />}
            </div>
        })}
    </div>
}

// not real
const PROCESSING_STAGE_LABELS = ["Extracting keywords…", "Matching sections…", "Rewriting bullets…", "Scoring resume…"]
const BASE_ESTIMATE_SECONDS = 45

// elapsed is real, the estimate is re-derived for user engagement
function useProgress() {
    const [elapsed, setElapsed] = useState(0)
    const [estimate, setEstimate] = useState(BASE_ESTIMATE_SECONDS)
    const startRef = useRef(Date.now())
    useEffect(() => {
        const tickId = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
        const estimateId = setInterval(() => {
            const nowElapsed = Math.floor((Date.now() - startRef.current) / 1000)
            setEstimate(prev => (nowElapsed >= prev ? nowElapsed + 15 : prev))
        }, 15000)
        return () => { clearInterval(tickId); clearInterval(estimateId) }
    }, [])
    return { elapsed, remaining: Math.max(0, estimate - elapsed) }
}

function ProcessingStages() {
    const [idx, setIdx] = useState(0)
    const { elapsed, remaining } = useProgress()
    useEffect(() => {
        const t = setInterval(() => setIdx(i => (i + 1) % PROCESSING_STAGE_LABELS.length), 3500)
        return () => clearInterval(t)
    }, [])
    return <span className="processing-stages">
        <span className="processing-stage-label">{PROCESSING_STAGE_LABELS[idx]}</span>
        <span className="processing-timer"><Clock size={12} /> {elapsed}s elapsed · ~{remaining}s remaining</span>
    </span>
}

function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return ""
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

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
            {analysing ? <><span className="spinner" /><ProcessingStages /></> : <><Sparkles size={16} /> Analyse My Resume</>}
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

function ResumeSetup({ file, setFile, jobDescription, setJobDescription, onAnalyse, onQuickCoverLetter, busy, quickBusy }) {
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
                                    <span className="upload-card-meta"><CheckCircle2 size={12} /> {formatFileSize(file.size)} · Uploaded</span>
                                </div>
                                <div className="upload-card-actions">
                                    <button type="button" className="btn-ghost btn-small" onClick={open}><RotateCw size={13} /> Replace</button>
                                    <button type="button" className="upload-card-remove" onClick={() => setFile(null)} title="Remove file"><Trash2 size={15} /></button>
                                </div>
                            </div>
                        ) : "Drop your resume here, or click to upload"}
                    </div>
                    {rejectionError && <p className="error-msg">{rejectionError}</p>}
                </div>
                <div>
                    <span className="section-label">Job Description <small>(optional for ATS matching)</small></span>
                    <textarea className="input-field" value={jobDescription} onChange={e => setJobDescription(e.target.value)} placeholder="Paste a full job description for keyword matching, or leave blank to improve the CV from rewrite decisions only." />
                </div>
            </div>
            <AnalyseSplitButton disabled={!file} analysing={busy} quickBusy={quickBusy} onAnalyse={onAnalyse} onQuickCoverLetter={onQuickCoverLetter} />
        </div>
    </section>
}

function useCountUp(target, duration = 700) {
    const [display, setDisplay] = useState(target)
    const prevRef = useRef(target)
    useEffect(() => {
        const start = prevRef.current
        if (start === target) return undefined
        const startTime = performance.now()
        let raf
        function tick(now) {
            const progress = Math.min(1, (now - startTime) / duration)
            setDisplay(Math.round(start + (target - start) * progress))
            if (progress < 1) raf = requestAnimationFrame(tick)
            else prevRef.current = target
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [target, duration])
    return display
}

// their own past attempts are the benchmark
function ownStanding(score, history) {
    if (!history || history.length < 2) return null
    const past = history.slice(1)
    if (past.every(h => score > h.score)) return "Your best score yet"
    const better = past.filter(h => h.score < score).length
    if (better === 0) return "Your lowest score yet"
    return `Better than ${Math.round((better / past.length) * 100)}% of your past attempts`
}

function ScoreCard({ scoreData, history, attemptType }) {
    // hooks before the early return below 
    const score = typeof scoreData === "object" ? scoreData?.total || 0 : scoreData || 0
    const displayScore = useCountUp(score)

    // never ran analyse(), and 0/100 reads as a bad score not n/a
    if (attemptType === "cover_letter_only") {
        return <div className="card score-card score-card-cover-letter-only">
            <span className="section-label">Resume Score</span>
            <div className="score-cta">
                <Mail size={22} />
                <p className="muted">This was a fast Cover Letter attempt - no scoring or rewrite suggestions were generated.</p>
            </div>
        </div>
    }
    const cfg = getScoreCfg(score)
    const lines = typeof scoreData === "object" ? [
        `Base: ${scoreData.base || 0}`,
        `Sections: +${scoreData.sections || 0}`,
        `Keywords: +${scoreData.keywords || 0}`,
        `Bullet Quality: +${scoreData.bullet_quality || 0}`,
        `Action Verbs: +${scoreData.action_verbs || 0}`,
        `Warnings: ${scoreData.warnings || 0}`,
        `Total: ${score}/100`,
    ] : ["Score breakdown not available"]
    const sectionScores = (typeof scoreData === "object" && scoreData?.section_scores) || {}
    const previousScore = history && history.length > 1 ? history[1].score : null
    const delta = previousScore != null ? score - previousScore : null
    const standing = ownStanding(score, history)

    return <div className="card score-card">
        <span className="section-label">Resume Score</span>
        <div className="score-tooltip-wrap">
            <div className="score-stack">
                <div className="score-ring" style={{ "--pct": score, "--ring-color": cfg.color }}>
                    <div className="score-ring-inner">
                        <div className="score-number" style={{ color: cfg.color }}>{displayScore}</div>
                        <span className="score-label-text" style={{ color: cfg.color }}>{cfg.label}</span>
                    </div>
                </div>
                <span className="score-sub">out of 100 · hover for breakdown</span>
                {delta !== null && delta !== 0 && (
                    <span className={`score-delta ${delta > 0 ? "up" : "down"}`}>
                        {delta > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                        {delta > 0 ? "+" : ""}{delta} since last analysis
                    </span>
                )}
                {standing && <span className="score-benchmark">{standing}</span>}
            </div>
            <div className="score-tooltip">
                {lines.map(line => <div key={line}>{line}</div>)}
                {Object.keys(sectionScores).length > 0 && <>
                    <div className="tooltip-divider" />
                    <div className="tooltip-heat-label">Section strength</div>
                    {Object.entries(sectionScores).map(([sec, data]) => {
                        const hq = heatmapQuality(data.quality)
                        return <div className="tooltip-heat-row" key={sec}>
                            <span className="heat-swatch" style={{ background: hq.color }} />
                            <span>{sec[0] + sec.slice(1).toLowerCase()}</span>
                            <span className="tooltip-heat-tag">{hq.label}</span>
                        </div>
                    })}
                </>}
            </div>
        </div>
    </div>
}

// no rewrites/score/keywords on these so show something
function AnalysisRequiredGate({ icon: Icon, message, onAnalyse, busy }) {
    return <div className="card analysis-gate">
        <Icon size={26} />
        <p>{message}</p>
        <button className="btn-primary" disabled={busy} onClick={onAnalyse}>
            {busy ? <><span className="spinner" /> Analysing…</> : <><Sparkles size={16} /> Analyse My Resume</>}
        </button>
    </div>
}

// one badge everywhere so the red circle looks the same
function NotificationBadge({ count }) {
    if (!count) return null
    return <span className="notif-badge">{count > 99 ? "99+" : count}</span>
}

// cover letters number per company unlike resume attempts
function numberClAtts(list) {
    const groups = {}
    for (const item of list) {
        const key = (item.company || "").trim().toLowerCase() || "__unknown__"
        ;(groups[key] = groups[key] || []).push(item)
    }
    const numberOf = {}
    for (const items of Object.values(groups)) {
        const ascending = [...items].reverse()
        ascending.forEach((item, i) => { numberOf[item.id] = i + 1 })
    }
    return numberOf
}

// either workflow each with its own toggle and numbering 
function AttemptHistory({ history, onOpenAttempt, unreadById = {} }) {
    const [tab, setTab] = useState("resume")
    const resumeAtts = useMemo(() => history.filter(h => h.attempt_type !== "cover_letter_only"), [history])
    const clAtts = useMemo(() => history.filter(h => h.attempt_type === "cover_letter_only"), [history])
    const clNumberOf = useMemo(() => numberClAtts(clAtts), [clAtts])
    const resumeUnread = resumeAtts.some(h => unreadById[h.id])
    const coverLetterUnread = clAtts.some(h => unreadById[h.id])
    const visible = tab === "resume" ? resumeAtts : clAtts

    return <section>
        <h2 className="view-title">Attempt History</h2>
        <div className="history-type-toggle">
            <button className={tab === "resume" ? "active" : ""} onClick={() => setTab("resume")}>Resume Analysis{resumeUnread && <NotificationBadge count={resumeAtts.filter(h => unreadById[h.id]).length} />}</button>
            <button className={tab === "cover_letter" ? "active" : ""} onClick={() => setTab("cover_letter")}>Cover Letters{coverLetterUnread && <NotificationBadge count={clAtts.filter(h => unreadById[h.id]).length} />}</button>
        </div>
        {!visible.length && <p className="muted">{tab === "resume" ? "No resume analyses yet - analyse a resume to start building your history." : "No cover letters yet - generate one to start building your history."}</p>}
        {visible.length > 0 && <div className="card mentor-history-table-wrap"><table><thead><tr>
            {tab === "resume"
                ? <><th>Attempt</th><th>Score</th><th>Date</th><th /></>
                : <><th>Company</th><th>Attempt</th><th>Job Match</th><th>Keyword Match</th><th>Date</th><th /></>}
        </tr></thead><tbody>
            {tab === "resume" && resumeAtts.map((item, index) => {
                const unread = !!unreadById[item.id]
                return <tr key={item.id} className={unread ? "history-row-unread-user" : ""}>
                    <td>#{resumeAtts.length - index}</td>
                    <td>{item.score}/100</td>
                    <td>{formatDateTime(item.created_at)}</td>
                    <td><button className="btn-secondary btn-small" onClick={() => onOpenAttempt(item.id)}>Open</button></td>
                </tr>
            })}
            {tab === "cover_letter" && clAtts.map(item => {
                const unread = !!unreadById[item.id]
                return <tr key={item.id} className={unread ? "history-row-unread-user" : ""}>
                    <td><Building2 size={12} /> {item.company || "Company not detected"}</td>
                    <td>#{clNumberOf[item.id]}</td>
                    <td>{item.job_match_pct != null ? `${item.job_match_pct}%` : "—"}</td>
                    <td>{item.keyword_match_pct != null ? `${item.keyword_match_pct}%` : "—"}</td>
                    <td>{formatDateTime(item.created_at)}</td>
                    <td><button className="btn-secondary btn-small" onClick={() => onOpenAttempt(item.id)}>Open</button></td>
                </tr>
            })}
        </tbody></table></div>}
    </section>
}

function ResumeMetadataModal({ contact, onClose }) {
    return createPortal(<div className="modal-overlay" onClick={onClose}>
        <div className="modal-panel" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
                <h3 className="modal-title">Resume Metadata</h3>
                <button className="btn-ghost modal-close" onClick={onClose} title="Close"><X size={18} /></button>
            </div>
            <div className="contact-grid">
                {Object.entries(contact).map(([key, value]) => (
                    <span className="contact-chip" key={key} title={String(value)}><b>{key}</b><span className="contact-value">{value}</span></span>
                ))}
            </div>
        </div>
    </div>, document.body)
}

function ResultsSidebar({ result, user, onLogout, history, collapsed, onToggleCollapse }) {
    const sections = result.sections || {}
    const [showMetadata, setShowMetadata] = useState(false)
    const contact = result.contact || {}
    const hasContact = Object.keys(contact).length > 0
    const scoreTotal = typeof result.score === "object" ? result.score?.total || 0 : result.score || 0

    // also stops App()'s scroll listener collapsing the sidebar under the modal
    useEffect(() => {
        if (!showMetadata) return undefined
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        return () => { document.body.style.overflow = prevOverflow }
    }, [showMetadata])

    return <>
        <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
        {collapsed ? (
            <div className="sidebar-content-fade" key="collapsed">
                <button className="sidebar-toggle" onClick={onToggleCollapse} title="Expand sidebar"><PanelLeftOpen size={18} /></button>
                {result.attempt_type === "cover_letter_only" ? (
                    <div className="sidebar-collapsed-score" title="Fast Cover Letter attempt - no score generated"><Mail size={20} /></div>
                ) : (
                    <div className="sidebar-collapsed-score" style={{ color: getScoreCfg(scoreTotal).color }} title={`Resume score: ${scoreTotal}/100`}>{scoreTotal}</div>
                )}
                <div className="sidebar-collapsed-icons">
                    {["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"].map(name => (
                        <span key={name} className={sections[name] ? "ok-text" : "error-text"} title={`${name[0] + name.slice(1).toLowerCase()}: ${sections[name] ? "found" : "missing"}`}>{sections[name] ? "✓" : "✗"}</span>
                    ))}
                </div>
            </div>
        ) : (
            <div className="sidebar-content-fade" key="expanded">
                <div className="sidebar-top">
                    <span className="sidebar-user">{user.is_guest ? "Browsing as " : "Signed in as "}<b>{user.display_name}</b></span>
                    <div className="sidebar-top-actions">
                        <button className="sidebar-toggle" onClick={onToggleCollapse} title="Collapse sidebar"><PanelLeftClose size={16} /></button>
                        <button className="btn-signout" onClick={onLogout}>{user.is_guest ? <><LogIn size={13} /> Sign In</> : <><LogOut size={13} /> Sign out</>}</button>
                    </div>
                </div>
                <ScoreCard scoreData={result.score} history={history.filter(h => h.attempt_type !== "cover_letter_only")} attemptType={result.attempt_type} />
                <div className="sidebar-scroll">
                    <div className="card"><span className="section-label">Parser Status</span>{["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"].map(name => <p key={name} className={sections[name] ? "ok-text" : "error-text"}>{sections[name] ? "✓" : "✗"} {name[0] + name.slice(1).toLowerCase()}</p>)}</div>
                    {hasContact && <button className="btn-ghost sidebar-metadata-btn" onClick={() => setShowMetadata(true)}><IdCard size={14} /> Resume Metadata</button>}
                    {user.role === "candidate" && <SessionJoin />}
                </div>
            </div>
        )}
        </aside>
        {showMetadata && <ResumeMetadataModal contact={contact} onClose={() => setShowMetadata(false)} />}
    </>
}

function SessionJoin() {
    const [code, setCode] = useState("")
    const [message, setMessage] = useState("")
    async function join() {
        try {
            await api.post("/mentor/session/join", { code })
            setMessage("Joined review session.")
        } catch (err) { setMessage(getError(err)) }
    }
    return <div className="card">
        <span className="section-label">Collaborative Review</span>
        <p className="session-join-hint muted">Ask your mentor for their session code to enable collaborative review of your resume.</p>
        <input className="input-field" value={code} onChange={e => setCode(e.target.value)} placeholder="Enter mentor session code" />
        <button className="btn-secondary btn-block-gap" onClick={join}>Join Session</button>
        {message && <p className="muted">{message}</p>}
    </div>
}

function decisionMark(state) {
    if (state === true) return "✓ "
    if (state === false) return "✗ "
    return "• "
}

// true while the mentor's version is live. dismissing hands it back to the ai one
function editSupersedes(feedback) {
    return !!feedback && feedback.status !== "dismissed"
}

// the ai suggestion is never throown away just struck through while the mentor's is live
function MentorSuggestionBlock({ baseText, feedback, viewerRole }) {
    if (!feedback) return null
    const dismissed = feedback.status === "dismissed"
    return <div className={`mentor-suggestion-block ${dismissed ? "is-dismissed" : ""}`}>
        <span className="pane-label">
            {viewerRole === "mentor" ? "Your Suggestion" : "Mentor's Suggestion"}
            {feedback.status === "accepted" && <span className="decision-flag accepted"><CheckCircle2 size={12} /> Accepted</span>}
            {dismissed && <span className="decision-flag dismissed"><XCircle size={12} /> Dismissed</span>}
        </span>
        <InlineDiff before={baseText} after={feedback.suggested_text} side="after" />
        {feedback.comment && <p className="feedback-comment">{feedback.comment}</p>}
        {dismissed && <p className="feedback-superseded-note">
            Dismissed &mdash; the suggestion above is the active recommendation again. Kept here as part of the review history.
        </p>}
    </div>
}

function RewriteReview({ result, file, decisions, setDecisions, analysisId }) {
    const [active, setActive] = useState(0)
    const [pdfUrl, setPdfUrl] = useState("")
    const [error, setError] = useState("")
    const [mentorEdits, setMentorEdits] = useState({})
    const actionable = useMemo(() => Object.entries(result.rewrites || {}).flatMap(([section, items]) => items.map((item, index) => ({ section, item, index, key: item.id || `${section}_${index}` })).filter(({ item }) => item.framework_used !== "none" && item.framework_used !== "error" && item.original !== item.rewritten)), [result])
    const count = actionable.length
    const current = actionable[Math.min(active, Math.max(count - 1, 0))]

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
    useEffect(() => { setActive(0); setError("") }, [analysisId])

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
        if (count > 1) setActive((active + 1) % count)
    }

    // ignored while typing so it can't hijack the comment box
    useEffect(() => {
        function onKeyDown(e) {
            const tag = (e.target.tagName || "").toLowerCase()
            if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return
            if (e.key === "a" || e.key === "A") decide(true)
            else if (e.key === "d" || e.key === "D") decide(false)
            else if (e.key === "ArrowLeft") setActive(a => (a - 1 + count) % count)
            else if (e.key === "ArrowRight") setActive(a => (a + 1) % count)
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current?.key, count, decisions])

    if (!count) return <div className="card muted">No rewrite-worthy sentences were detected. Header and label lines were skipped.</div>
    const state = decisions[current.key]
    const reviewedCount = actionable.filter(({ key }) => decisions[key] !== undefined).length
    return <>
        <h2 className="view-title">Review Suggestions</h2>
        {error && <p className="error-msg">{error}</p>}
        <div className="review-toolbar">
            <span className="review-progress">{reviewedCount} of {count} reviewed</span>
            <span className="status-chip accepted-chip">{Object.values(decisions).filter(v => v).length} accepted</span>
            <span className="status-chip dismissed-chip">{Object.values(decisions).filter(v => v === false).length} dismissed</span>
            <span className="toolbar-spacer" />
            <span className="kbd-hint"><kbd>A</kbd> accept · <kbd>D</kbd> dismiss · <kbd>←</kbd><kbd>→</kbd> navigate</span>
            <button className="btn-secondary" onClick={() => save(Object.fromEntries(actionable.map(({ key }) => [key, true])))}>Accept all</button>
            <button className="btn-ghost" onClick={() => save({})}>Clear decisions</button>
        </div>
        <div className="two-col-pdf"><div><span className="section-label">Highlighted Resume</span>{pdfUrl ? <div className="pdf-shell"><iframe className="pdf-frame" src={pdfUrl} title="Uploaded resume" /></div> : <div className="card muted">Source preview is available for PDF uploads. Parsed content remains available under Extracted Sections.</div>}</div>
            <div>
                <div className="review-nav">
                    <button className="btn-secondary btn-arrow" onClick={() => setActive((active - 1 + count) % count)} title="Previous suggestion"><ChevronLeft size={16} /></button>
                    <select
                        className="input-field suggestion-jump"
                        value={Math.min(active, count - 1)}
                        onChange={e => setActive(Number(e.target.value))}
                    >
                        {actionable.map(({ section, item, key }, idx) => (
                            <option key={key} value={idx}>
                                {decisionMark(decisions[key])}{idx + 1} of {count} · {section} · {(item.original || "").slice(0, 48)}{(item.original || "").length > 48 ? "…" : ""}
                            </option>
                        ))}
                    </select>
                    <button className="btn-secondary btn-arrow" onClick={() => setActive((active + 1) % count)} title="Next suggestion"><ChevronRight size={16} /></button>
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

// one flat thread per suggestion
function AnnotationThread({ analysisId, suggestionKey, section, viewerRole = "candidate" }) {
    const [annotations, setAnnotations] = useState([])
    const [comment, setComment] = useState("")
    const [error, setError] = useState("")

    async function load() {
        if (!analysisId || !suggestionKey) { setAnnotations([]); return }
        try {
            const res = await api.get(`/annotations/${analysisId}`)
            setAnnotations(res.data.filter(item => item.key === suggestionKey))
        } catch { setAnnotations([]) }
    }
    useEffect(() => { load() }, [analysisId, suggestionKey])

    async function postComment() {
        if (!comment.trim() || !analysisId || !suggestionKey) return
        setError("")
        try {
            await api.post("/annotations", { analysis_id: analysisId, suggestion_key: suggestionKey, comment, section: section || "" })
            setComment("")
            await load()
        } catch (err) { setError(`Couldn't post comment: ${getError(err)}`) }
    }

    return <div className="annotation-thread">
        <span className="section-label">Discussion</span>
        {error && <p className="warning-strip">{error}</p>}
        {annotations.length === 0 && <p className="muted annotation-empty">No comments yet - {viewerRole === "mentor" ? "leave a note or ask the candidate a question about this suggestion." : "ask your mentor a question or leave a note about this suggestion."}</p>}
        {annotations.map(annotation => (
            <div className="annotation-card" key={annotation.id}>
                <span className={`ann-user ${annotation.role === "mentor" ? "ann-user-mentor" : ""}`}>{annotation.role === viewerRole ? "You" : annotation.role === "mentor" ? `${annotation.user} (Mentor)` : annotation.user}</span>
                <span className="ann-time">{formatDateTime(annotation.time)}</span>
                <div className="ann-body">{annotation.comment}</div>
            </div>
        ))}
        <div className="annotation-input">
            <input className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder={viewerRole === "mentor" ? "Reply or leave a note for the candidate" : "Ask a question or leave a comment for your mentor"} />
            <button className="btn-secondary" onClick={postComment}>Post Comment</button>
        </div>
    </div>
}

function KeywordGap({ result }) {
    const keywords = result.jd_keywords || []
    if (!keywords.length) {
        if (result.keyword_extraction_failed) return <><h2 className="view-title">Keyword Gap</h2><p className="warning-strip">Keyword extraction from the job description failed (the model may be rate-limited or temporarily unavailable). Re-run the analysis to try again.</p></>
        return <><h2 className="view-title">Keyword Gap</h2><p className="muted">Paste a job description above and re-analyse to see keyword gaps.</p></>
    }
    const missing = result.missing_keywords || []
    const present = keywords.filter(item => !missing.includes(item))
    const coverage = Math.round(present.length / keywords.length * 100)
    return <><h2 className="view-title">Keyword Gap</h2><div className="card"><span className="section-label">Coverage</span><p className="metric-value">{coverage}%</p><p className="muted">{present.length} of {keywords.length} JD keywords present in your resume</p></div><div className="two-col"><div><span className="section-label"><XCircle size={13} /> Missing ({missing.length})</span><div className="kw-wrap">{missing.map(item => <span className="kw-missing" key={item}>{item}</span>)}</div></div><div><span className="section-label"><CheckCircle2 size={13} /> Present ({present.length})</span><div className="kw-wrap">{present.map(item => <span className="kw-present" key={item}>{item} ({result.keyword_frequencies?.[item] || 0})</span>)}</div></div></div></>
}

function ExtractedSections({ result }) {
    return <div><h2 className="view-title">Extracted Sections</h2>{Object.entries(result.sections || {}).map(([name, lines]) => <details className="card" key={name} open={name === "EXPERIENCE"}><summary>{name}</summary><pre className="section-pre">{lines.join("\n")}</pre></details>)}</div>
}

function downloadText(text, filename) {
    const href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }))
    const link = document.createElement("a")
    link.href = href
    link.download = filename
    link.click()
    URL.revokeObjectURL(href)
}

function SavedIndicator({ state }) {
    if (state === "idle") return null
    if (state === "error") return <span className="saved-indicator error"><XCircle size={12} /> Save failed</span>
    return <span className={`saved-indicator ${state}`}>{state === "saving" ? <><Loader2 size={12} className="spin-icon" /> Saving…</> : <><CheckCircle2 size={12} /> Saved</>}</span>
}

function DocumentGenerator({ type, result, provider, localEndpoint, decisions, analysisId, text, setText, onExport, fullName, company, onChangeJobDescription }) {
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

const SECTION_ORDER = [
    "EXPERIENCE", "PROJECTS", "EDUCATION", "SKILLS", "SUMMARY", "CERTIFICATIONS",
    "AWARDS", "PUBLICATIONS", "VOLUNTEER", "LANGUAGES", "INTERESTS", "REFERENCES",
]

function Insights({ result, history, decisions }) {
    const timing = result.timing || {}
    const [consent, setConsent] = useState(false)
    const [confidence, setConfidence] = useState("")
    const [comment, setComment] = useState("")
    const [submitted, setSubmitted] = useState(false)
    const [error, setError] = useState("")
    const [overview, setOverview] = useState(null)

    useEffect(() => {
        api.get("/analysis/insights/overview").then(res => setOverview(res.data.analyses || [])).catch(() => setOverview([]))
    }, [])

    async function submitFeedback() {
        setError("")
        try {
            await api.post("/feedback", { analysis_id: result.analysis_id, consent, confidence, comment })
            setSubmitted(true)
        } catch (err) {
            setError(getError(err))
        }
    }

    const sectionCols = overview ? (() => {
        const present = new Set(overview.flatMap(a => Object.keys(a.score?.section_scores || {})))
        return [...SECTION_ORDER.filter(s => present.has(s)), ...[...present].filter(s => !SECTION_ORDER.includes(s)).sort()]
    })() : []

    const jdKeywords = result.jd_keywords || []
    const missingKeywords = result.missing_keywords || []
    const atsMatch = jdKeywords.length ? Math.round(((jdKeywords.length - missingKeywords.length) / jdKeywords.length) * 100) : null

    const gradedSections = Object.entries(result.score?.section_scores || {}).filter(([, d]) => d.bullet_count > 0)
    let strongest = null, weakest = null
    for (const [sec, d] of gradedSections) {
        if (!strongest || d.quality > strongest.quality) strongest = { sec, quality: d.quality }
        if (!weakest || d.quality < weakest.quality) weakest = { sec, quality: d.quality }
    }

    let mostImproved = null
    if (overview && overview.length >= 2) {
        const latest = overview[overview.length - 1]
        const prior = overview[overview.length - 2]
        for (const [sec, d] of Object.entries(latest.score?.section_scores || {})) {
            const priorQ = prior.score?.section_scores?.[sec]?.quality
            if (priorQ == null) continue
            const delta = d.quality - priorQ
            if (delta > 0 && (!mostImproved || delta > mostImproved.delta)) mostImproved = { sec, delta }
        }
    }

    const decisionValues = Object.values(decisions || {})
    const acceptedCount = decisionValues.filter(v => v === true).length
    const dismissedCount = decisionValues.filter(v => v === false).length
    const titleCase = s => s[0] + s.slice(1).toLowerCase()

    return <section>
        <h2 className="view-title">Insights</h2>

        <div className="metric-grid">
            <div className="stat-card">
                <span className="stat-label">ATS Match</span>
                <span className="stat-value">{atsMatch !== null ? `${atsMatch}%` : "—"}</span>
                <span className="stat-caption">{atsMatch !== null ? `${jdKeywords.length - missingKeywords.length} of ${jdKeywords.length} JD keywords present` : "No job description provided"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Keyword Coverage</span>
                <span className="stat-value">{atsMatch !== null ? `${atsMatch}%` : "—"}</span>
                <span className="stat-caption">{atsMatch === null ? "Add a job description to see this" : missingKeywords.length ? `${missingKeywords.length} keywords missing` : "All keywords covered"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Strongest Section</span>
                <span className="stat-value stat-value-text">{strongest ? titleCase(strongest.sec) : "—"}</span>
                <span className="stat-caption">{strongest ? `${strongest.quality}% quality` : "Not enough data yet"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Weakest Section</span>
                <span className="stat-value stat-value-text">{weakest ? titleCase(weakest.sec) : "—"}</span>
                <span className="stat-caption">{weakest ? `${weakest.quality}% quality` : "Not enough data yet"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Most Improved Section</span>
                <span className="stat-value stat-value-text">{mostImproved ? titleCase(mostImproved.sec) : "—"}</span>
                <span className="stat-caption">{mostImproved ? `+${mostImproved.delta}% since last attempt` : "Run a second analysis to compare"}</span>
            </div>
            <div className="stat-card">
                <span className="stat-label">Suggestions Reviewed</span>
                <span className="stat-value"><span className="stat-accept">{acceptedCount}</span> / <span className="stat-dismiss">{dismissedCount}</span></span>
                <span className="stat-caption">accepted / dismissed</span>
            </div>
        </div>

        <h3 className="doc-subhead">Resume Score History</h3>
        <div className="card history-list">{history.length ? history.map((item, index) => <div key={item.id || index}><b>Attempt {history.length - index}</b><span className="tabular-num">{item.attempt_type === "cover_letter_only" ? "Cover Letter" : `${item.score}/100`}</span><small>{formatDateTime(item.created_at)}</small></div>) : <p className="muted">Run more analyses to see score progression.</p>}</div>

        <h3 className="doc-subhead">Readability &amp; Quality Heatmap</h3>
        <p className="muted">How strong each section's writing has been across your attempts. Each row is one attempt, oldest first.</p>
        {overview && overview.length > 0 && sectionCols.length > 0 ? <div className="heatmap-table-wrap"><table className="heatmap-table"><thead><tr><th>Attempt</th>{sectionCols.map(sec => <th key={sec}>{titleCase(sec)}</th>)}</tr></thead><tbody>{overview.map((a, idx) => <tr key={a.id}><td className="heatmap-row-label"><b>#{idx + 1}</b><small>{String(a.created_at || "").slice(0, 10)}</small></td>{sectionCols.map(sec => {
            const cell = a.score?.section_scores?.[sec]
            if (!cell) return <td key={sec}><div className="heatmap-square empty">—</div></td>
            const hq = heatmapQuality(cell.quality)
            return <td key={sec}><div className="heatmap-square" style={{ background: hq.color }} title={`${hq.label} — ${cell.quality}%`}>
                <span className="heatmap-square-pct">{cell.quality}%</span>
                <span className="heatmap-square-label">{hq.label}</span>
            </div></td>
        })}</tr>)}</tbody></table></div> : <p className="muted">{overview ? "Run more analyses to build up the heatmap." : "Loading…"}</p>}

        <details className="card technical-details">
            <summary>Technical Details</summary>
            <div className="three-col tech-metric-grid">{Object.entries(timing).map(([key, value]) => <div className="tech-metric" key={key}><div className="tech-metric-value">{formatDuration(value)}</div><div className="metric-label">{key.replace("_ms", "").replace("_", " ")}</div></div>)}</div>
        </details>

        <div className="card evaluation-card"><span className="section-label">Optional Evaluation</span><p className="muted">Share anonymised confidence feedback without including your resume content.</p>{submitted ? <p className="success-msg">Thanks for your feedback.</p> : <><label className="toggle-wrap"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I consent to store this evaluation response.</label><label className="form-group">Confidence in these recommendations<span className="confidence-scale-hint">1 = Worst · 5 = Best</span><select className="input-field" value={confidence} onChange={e => setConfidence(e.target.value)}><option value="">Select a rating</option>{[1, 2, 3, 4, 5].map(value => <option value={value} key={value}>{value}</option>)}</select></label><textarea className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional qualitative feedback" />{error && <p className="error-msg">{error}</p>}<button className="btn-secondary btn-block-gap" disabled={!consent} onClick={submitFeedback}>Submit Feedback</button></>}</div>
    </section>
}

function FeedbackComposer({ candidateId, analysisId, prefill, onSent }) {
    const [type, setType] = useState(prefill?.type || "comment")
    const [section, setSection] = useState(prefill?.section || "")
    const [originalText, setOriginalText] = useState(prefill?.original || "")
    const [suggestedText, setSuggestedText] = useState("")
    const [comment, setComment] = useState("")
    const [status, setStatus] = useState("")

    // the composer stays mounted and just swaps prefill
    useEffect(() => {
        if (prefill) {
            setType(prefill.type || "comment")
            setSection(prefill.section || "")
            setOriginalText(prefill.original || "")
            // prefilled when revising a dismissed one
            setSuggestedText(prefill.suggested || "")
            setComment("")
            setStatus("")
        }
        // sync all changes
    }, [prefill?.key, prefill?.seed])

    async function send() {
        setStatus("")
        try {
            await api.post("/mentor/feedback", {
                candidate_id: candidateId,
                analysis_id: analysisId || null,
                suggestion_key: prefill?.key || "",
                feedback_type: type,
                section,
                original_text: originalText,
                suggested_text: suggestedText,
                comment,
            })
            setStatus("Sent.")
            setSuggestedText("")
            setComment("")
            onSent?.(suggestedText)
        } catch (err) {
            setStatus(getError(err))
        }
    }

    const isEditLike = type === "edit" || type === "section_edit"
    return <div className="card composer">
        <span className="section-label">Send Feedback to Candidate</span>
        <div className="composer-row">
            <select className="input-field composer-type" value={type} onChange={e => setType(e.target.value)}>
                <option value="comment">Comment</option>
                <option value="edit">Bullet Edit</option>
                <option value="section_edit">Section Edit</option>
            </select>
            <input className="input-field" value={section} onChange={e => setSection(e.target.value)} placeholder="Section (e.g. EXPERIENCE, optional)" />
        </div>
        {isEditLike && <>
            <textarea className="input-field composer-area" value={originalText} onChange={e => setOriginalText(e.target.value)} placeholder={type === "section_edit" ? "Original text of the whole section" : "Original text this edit applies to"} />
            <textarea className="input-field composer-area" value={suggestedText} onChange={e => setSuggestedText(e.target.value)} placeholder={type === "section_edit" ? "Your rewritten version of the whole section" : "Your suggested replacement text"} />
        </>}
        <textarea className="input-field composer-area" value={comment} onChange={e => setComment(e.target.value)} placeholder={isEditLike ? "Why this edit helps (optional)" : "Your feedback"} />
        <div className="composer-actions">
            <button className="btn-primary" onClick={send}>Send Feedback</button>
            {status && <span className="muted">{status}</span>}
        </div>
    </div>
}

function CandidateDetail({ candidate, onBack, notifSummary, refreshNotifs }) {
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

// everything merged into one ordered list 
function RevisionTimeline({ analysisId, documentType, viewerRole = "candidate", refreshKey = 0, onReuse }) {
    const [data, setData] = useState(null)
    const [error, setError] = useState("")

    useEffect(() => {
        if (!analysisId) { setData(null); return undefined }
        let cancelled = false
        setError("")
        api.get(`/generate/timeline?analysis_id=${analysisId}&document_type=${documentType}`)
            .then(res => { if (!cancelled) setData(res.data) })
            .catch(err => { if (!cancelled) setError(getError(err)) })
        return () => { cancelled = true }
    }, [analysisId, documentType, refreshKey])

    const entries = useMemo(() => {
        if (!data) return []
        const out = []
        // every generation a jd refresh makes another and dropping it leaves a hole
        ;(data.versions || []).filter(v => v.source === "ai").forEach((v, i) => {
            out.push({
                key: `ai-${v.id}`, at: v.created_at, kind: "ai",
                title: i === 0 ? "AI Generated" : "AI Regenerated", body: v.content,
            })
        })
        for (const v of (data.versions || []).filter(v => v.source === "user")) {
            out.push({
                key: `user-${v.id}`, at: v.created_at, kind: "user",
                title: viewerRole === "candidate" ? "Your edit" : `${v.author_name || "Candidate"}'s edit`, body: v.content,
            })
        }
        // in the order sent each followed by its decision
        ;(data.feedback || []).forEach((f, i) => {
            out.push({
                key: `mf-${f.id}`, at: f.created_at, kind: "mentor", feedback: f,
                title: `Mentor Revision #${i + 1}`, author: f.mentor_name,
                before: f.original_text, after: f.suggested_text, comment: f.comment,
            })
            if (f.status !== "open") {
                out.push({
                    key: `dec-${f.id}`, at: f.updated_at, kind: "decision", status: f.status,
                    title: `User Decision · Revision #${i + 1}`, feedback: f,
                })
            }
        })
        for (const d of (data.discussion || [])) {
            out.push({ key: `an-${d.id}`, at: d.created_at, kind: "comment", title: d.author_name, authorRole: d.author_role, body: d.comment })
        }
        return out.sort((a, b) => parseTs(a.at) - parseTs(b.at))
    }, [data, viewerRole])

    if (error) return <p className="warning-strip">{error}</p>
    if (!data) return null
    if (!entries.length) return <p className="muted">No revisions recorded for this attempt yet.</p>

    return <ol className="revision-timeline">
        {entries.map(entry => <li className={`revision-entry revision-${entry.kind}`} key={entry.key}>
            <div className="revision-head">
                <span className="revision-title">{entry.title}</span>
                {entry.author && <span className="status-chip">{entry.author}</span>}
                {entry.kind === "decision" && (entry.status === "accepted"
                    ? <span className="decision-flag accepted"><CheckCircle2 size={12} /> Accepted</span>
                    : <span className="decision-flag dismissed"><XCircle size={12} /> Dismissed</span>)}
                <span className="revision-time">{formatDateTime(entry.at)}</span>
            </div>
            {entry.kind === "mentor" && <DocumentDiff
                before={entry.before} after={entry.after}
                labelBefore="Before" labelAfter="Mentor rewrite"
                className={entry.feedback.status === "dismissed" ? "" : "original-superseded"}
            />}
            {entry.comment && <p className="feedback-comment">{entry.comment}</p>}
            {entry.body && entry.kind !== "mentor" && <pre className="section-pre revision-body">{entry.body}</pre>}
            {/* a dismissed revision is where the next one starts */}
            {entry.kind === "decision" && entry.status === "dismissed" && viewerRole === "mentor" && onReuse &&
                <button className="pill suggest-edit-pill" onClick={() => onReuse(entry.feedback)}>
                    <RotateCw size={12} /> Reuse &amp; revise this suggestion
                </button>}
        </li>)}
    </ol>
}

// its own component, almost nothing is shared with the resume workspace
function CoverLetterWorkspace({ candidate, attempts, sent, onSent, unreadById = {} }) {
    const [openId, setOpenId] = useState(null)
    const [content, setContent] = useState("")
    const [baseline, setBaseline] = useState("")
    const [comment, setComment] = useState("")
    const [pdfUrl, setPdfUrl] = useState("")
    const [diffFrom, setDiffFrom] = useState("")
    const [diffTo, setDiffTo] = useState("")
    const [diff, setDiff] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [historyOpen, setHistoryOpen] = useState(true)
    const [refreshKey, setRefreshKey] = useState(0)

    const clNumberOf = useMemo(() => numberClAtts(attempts), [attempts])
    const open = attempts.find(a => a.id === openId)
    const sameCo = open
        ? attempts.filter(a => (a.company || "").trim().toLowerCase() === (open.company || "").trim().toLowerCase())
        : []

    // feedback from previous attempts at the same company only
    const openCompanyKey = open ? (open.company || "").trim().toLowerCase() : ""
    const previousCompanyAttemptIds = open
        ? sameCo.filter(a => a.id !== openId).map(a => a.id)
        : []
    const currentFeedback = sent.filter(f => f.analysis_id === openId && f.suggestion_key && f.suggestion_key.startsWith("cover_letter:"))
    const previousFeedback = sent
        .filter(f => previousCompanyAttemptIds.includes(f.analysis_id) && f.suggestion_key && f.suggestion_key.startsWith("cover_letter:"))
        .sort((a, b) => parseTs(a.created_at) - parseTs(b.created_at))

    async function openAttempt(id) {
        setDiff(null)
        setDiffFrom(""); setDiffTo("")
        setOpenId(id)
        setHistoryOpen(false)
        setError("")
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/analyses/${id}/cover-letter`)
            const savedContent = res.data.content || ""
            // resume from their own draft if there is one
            const mine = sent
                .filter(f => f.analysis_id === id && f.suggestion_key === `cover_letter:${id}`)
                .sort((a, b) => parseTs(b.updated_at || b.created_at) - parseTs(a.updated_at || a.created_at))[0]
            setBaseline(savedContent)
            setContent(mine ? mine.suggested_text : savedContent)
            setComment("")
            api.post("/notifications/mark-read", { analysis_id: id }).catch(() => {})
        } catch (err) { setError(getError(err)) }
    }

    // plain and unhighlighted unlike the analysis workspace
    useEffect(() => {
        if (!open) { setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return "" }); return undefined }
        let cancelled = false
        let createdUrl = ""
        api.get(`/mentor/candidates/${candidate.id}/resumes/${open.resume_id}/file`, { responseType: "blob" }).then(res => {
            if (cancelled) return
            createdUrl = URL.createObjectURL(res.data)
            setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return createdUrl })
        }).catch(() => { if (!cancelled) setPdfUrl("") })
        return () => { cancelled = true; if (createdUrl) URL.revokeObjectURL(createdUrl) }
    }, [open?.resume_id, candidate.id])

    async function submit() {
        if (!content.trim() || !open) return
        setBusy(true)
        setError("")
        try {
            await api.post("/mentor/feedback", {
                candidate_id: candidate.id,
                analysis_id: open.id,
                suggestion_key: `cover_letter:${open.id}`,
                feedback_type: "edit",
                section: "Cover Letter",
                original_text: baseline,
                suggested_text: content,
                comment,
            })
            setBaseline(content)
            setComment("")
            setRefreshKey(k => k + 1)
            toast("Cover letter feedback sent to candidate")
            onSent()
        } catch (err) { setError(getError(err)) } finally { setBusy(false) }
    }

    // a dismissed rewrite is where the next one starts
    function reuseSuggestion(f) {
        setContent(f.suggested_text || "")
        setComment("")
        toast("Previous suggestion loaded — amend it and submit again")
    }

    async function runDiff() {
        if (!diffFrom || !diffTo) return
        try {
            const res = await api.get(`/mentor/candidates/${candidate.id}/cover-letter-diff?from=${diffFrom}&to=${diffTo}`)
            setDiff(res.data)
        } catch (err) { setError(getError(err)) }
    }

    function renderFeedbackItem(f) {
        return <div className={`card feedback-item ${f.status}`} key={f.id}>
            <div className="feedback-meta">
                <span className="fw-badge">Suggested Edit</span>
                {f.section && <span className="status-chip">{f.section}</span>}
                {f.status === "accepted" ? <span className="decision-flag accepted"><CheckCircle2 size={12} /> Accepted</span>
                    : f.status === "dismissed" ? <span className="decision-flag dismissed"><XCircle size={12} /> Dismissed</span>
                    : <span className={`status-chip status-${f.status}`}>{capitalize(f.status)}</span>}
                <span className="feedback-attempt-meta">{formatShortDate(f.created_at)}</span>
            </div>
            {f.feedback_type === "edit" && <DocumentDiff
                before={f.original_text} after={f.suggested_text}
                labelBefore="Original cover letter" labelAfter="Your rewrite"
                className={f.status === "dismissed" ? "" : "original-superseded"}
            />}
            {f.comment && <p className="feedback-comment">{f.comment}</p>}
            {f.status === "dismissed" && <button className="pill suggest-edit-pill" onClick={() => reuseSuggestion(f)}>
                <RotateCw size={12} /> Reuse &amp; revise this suggestion
            </button>}
            <AnnotationThread analysisId={f.analysis_id} suggestionKey={`cover_letter_feedback:${f.id}`} section="Cover Letter" viewerRole="mentor" />
        </div>
    }

    return <div className="cl-workspace-grid">
        <div className="cl-workspace-left">
            <details className="card mentor-history-card" open={historyOpen} onToggle={e => setHistoryOpen(e.currentTarget.open)}>
                <summary>Cover Letter History</summary>
                <div className="mentor-history-table-wrap"><table><thead><tr><th>Company</th><th>Attempt</th><th>Job Match</th><th>Keyword Match</th><th>Date</th><th /></tr></thead><tbody>
                    {attempts.map(a => <tr key={a.id} className={`${openId === a.id ? "mentor-history-row-open" : ""} ${unreadById[a.id] ? "history-row-unread-mentor" : ""}`}>
                        <td><Building2 size={12} /> {a.company || "Company not detected"}</td>
                        <td>#{clNumberOf[a.id]}</td>
                        <td>{a.job_match_pct != null ? `${a.job_match_pct}%` : "—"}</td>
                        <td>{a.keyword_match_pct != null ? `${a.keyword_match_pct}%` : "—"}</td>
                        <td>{formatDateTime(a.created_at)}</td>
                        <td><button className="btn-secondary btn-small" onClick={() => openAttempt(a.id)}>Open</button></td>
                    </tr>)}
                    {!attempts.length && <tr><td colSpan={6} className="muted">No cover letters yet.</td></tr>}
                </tbody></table></div>
            </details>
            {error && <p className="warning-strip">{error}</p>}
            {!diff && open && <>
                <span className="section-label">Cover Letter Preview</span>
                <textarea className="input-field doc-editor mentor-preview-editor" value={content} onChange={e => setContent(e.target.value)} />
                <div className="mentor-preview-actions cover-letter-submit-row">
                    <textarea className="input-field cover-letter-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional comment for the candidate" />
                    <button className="btn-primary" disabled={busy || !content.trim()} onClick={submit}><Check size={15} /> Submit</button>
                </div>
            </>}
            {!diff && !open && <div className="card muted">Open a cover letter attempt to review it.</div>}
            <span className="section-label">Compare Revisions</span>
            <p className="muted">Only attempts for the same company as the one you have open can be compared.</p>
            <div className="card">
                <div className="composer-row">
                    <select className="input-field" value={diffFrom} onChange={e => setDiffFrom(e.target.value)} disabled={!open}>
                        <option value="">Before…</option>
                        {sameCo.map(a => <option key={a.id} value={a.id}>#{clNumberOf[a.id]} · {formatDateTime(a.created_at)}</option>)}
                    </select>
                    <select className="input-field" value={diffTo} onChange={e => setDiffTo(e.target.value)} disabled={!open}>
                        <option value="">After…</option>
                        {sameCo.map(a => <option key={a.id} value={a.id}>#{clNumberOf[a.id]} · {formatDateTime(a.created_at)}</option>)}
                    </select>
                    <button className="btn-primary" onClick={runDiff} disabled={!diffFrom || !diffTo || diffFrom === diffTo}>Compare</button>
                </div>
            </div>
            {diff && <details className="card cl-diff-result" open>
                <summary>Cover Letter Diff · #{clNumberOf[diff.from.id]} ({diff.from.company || "company not detected"}) → #{clNumberOf[diff.to.id]}</summary>
                <DocumentDiff before={diff.before} after={diff.after} labelBefore="Earlier attempt" labelAfter="Later attempt" />
            </details>}
            {open && currentFeedback.length > 0 && <>
                <span className="section-label">Current Attempt Feedback</span>
                <div className="feedback-list">{currentFeedback.map(renderFeedbackItem)}</div>
            </>}
            {open && previousFeedback.length > 0 && <details className="card cl-previous-feedback">
                <summary>Previous Feedback — {open.company || "this company"} ({previousFeedback.length})</summary>
                <div className="feedback-list">{previousFeedback.map(renderFeedbackItem)}</div>
            </details>}
            {/* the whole trail for this attempt - the original letter, every mentor
                revision, each accept/dismiss decision, and the discussion around them */}
            {open && <details className="card cl-previous-feedback" open>
                <summary>Revision Timeline{open.company ? ` — ${open.company}` : ""}</summary>
                <RevisionTimeline
                    analysisId={open.id} documentType="cover_letter" viewerRole="mentor"
                    refreshKey={refreshKey} onReuse={reuseSuggestion}
                />
            </details>}
        </div>
        <div className="cl-workspace-right">
            {open && (pdfUrl ? <div className="pdf-shell"><iframe className="pdf-frame" src={pdfUrl} title="Candidate's original resume" /></div> : <div className="card muted">Source preview is available for PDF uploads only.</div>)}
            {!open && <div className="card muted">Open a cover letter attempt to see the original resume.</div>}
        </div>
    </div>
}

function MentorDashboard() {
    const [data, setData] = useState(null)
    const [error, setError] = useState("")
    const [openCandidate, setOpenCandidate] = useState(null)
    const [newCode, setNewCode] = useState("")
    const [notifSummary, refreshNotifs] = useNotifSummary(true)

    async function load() {
        try { setData((await api.get("/mentor/dashboard")).data) } catch (err) { setError(getError(err)) }
    }
    useEffect(() => { load() }, [])

    async function createSession() {
        try {
            const res = await api.post("/mentor/session")
            setNewCode(res.data.code)
            await load()
        } catch (err) { setError(getError(err)) }
    }

    async function deactivate(code) {
        try {
            await api.post(`/mentor/session/${code}/close`)
            await load()
        } catch (err) { setError(getError(err)) }
    }

    if (error) return <p className="warning-strip">{error}</p>
    if (!data) return <p className="muted">Loading mentor dashboard...</p>
    if (openCandidate) return <CandidateDetail candidate={openCandidate} onBack={() => { setOpenCandidate(null); refreshNotifs() }} notifSummary={notifSummary} refreshNotifs={refreshNotifs} />

    return <section>
        <div className="detail-head">
            <h2 className="view-title" style={{ marginBottom: 0 }}>Mentor Dashboard</h2>
            <button className="btn-primary" onClick={createSession}>Create Review Session</button>
        </div>
        {newCode && <p className="success-msg">Session created — share code <b>{newCode}</b> with your candidates.</p>}
        <div className="card"><span className="section-label">Sessions</span>
            {data.sessions.length ? data.sessions.map(session => <p className="session-row" key={session.id}>
                <b className="session-code">{session.session_code}</b>
                <span className={`status-chip ${session.active ? "status-accepted" : ""}`}>{session.active ? "Active" : "Closed"}</span>
                <span className="muted">{session.participants.filter(p => p.role === "candidate").map(item => item.display_name).join(", ") || "No participants yet"}</span>
                {session.active && <button className="btn-destructive btn-small session-deactivate" onClick={() => deactivate(session.session_code)}><Ban size={13} /> Deactivate</button>}
            </p>) : <p className="muted">No sessions yet — create one and share the code.</p>}
        </div>
        <span className="section-label">Candidates</span>
        <div className="card mentor-table"><table><thead><tr><th>Candidate</th><th>Analyses</th><th>Latest</th><th>Best</th><th /></tr></thead><tbody>
            {data.candidates.map(candidate => <tr key={candidate.id}>
                <td>{candidate.name}<NotificationBadge count={notifSummary.by_candidate_id[candidate.id]} /></td>
                <td>{candidate.total_analyses}</td>
                <td style={{ color: getScoreCfg(candidate.latest_score).color, fontWeight: 700 }}>{candidate.latest_score}</td>
                <td>{candidate.best_score}</td>
                <td><button className="btn-secondary btn-small" onClick={() => setOpenCandidate(candidate)}>Open workspace</button></td>
            </tr>)}
            {!data.candidates.length && <tr><td colSpan={5} className="muted">No candidates have joined a session yet.</td></tr>}
        </tbody></table></div>
    </section>
}

function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s
}

// sqlite datetimes are naive utc
function parseTs(value) {
    if (!value) return null
    const iso = typeof value === "string" && value.includes(" ") && !value.includes("T") ? `${value.replace(" ", "T")}Z` : value
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d
}

function formatShortDate(value) {
    const d = parseTs(value)
    return d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : ""
}

// for where a bare date can't distinguish
function formatDateTime(value) {
    const d = parseTs(value)
    return d ? d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : ""
}

// exact match on the open attempt
function FeedbackInbox({ analysisId, attemptType, unreadByType = {}, onDocumentAccepted }) {
    const [items, setItems] = useState(null)
    const [error, setError] = useState("")
    // stops a double-click firing two requests before the re-fetch lands
    const [busyId, setBusyId] = useState(null)
    // follows the open attempt 
    const [tab, setTab] = useState(attemptType === "cover_letter_only" ? "cover_letter" : "resume")
    useEffect(() => {
        if (attemptType) setTab(attemptType === "cover_letter_only" ? "cover_letter" : "resume")
    }, [analysisId, attemptType])

    async function load() {
        try { setItems((await api.get("/mentor/feedback/inbox")).data) } catch (err) { setError(getError(err)) }
    }
    useEffect(() => { load() }, [])

    async function setStatus(id, status) {
        if (busyId) return
        setBusyId(id)
        try {
            const res = await api.post(`/mentor/feedback/${id}/status`, { status })
            await load()
            // effective server-side already (see documents.js), so update the open editor
            if (res.data.document_type && res.data.content !== undefined) {
                onDocumentAccepted?.(res.data.document_type, res.data.content)
            }
        } catch (err) { setError(getError(err)) } finally { setBusyId(null) }
    }

    if (error) return <p className="warning-strip">{error}</p>
    if (!items) return <p className="muted">Loading feedback...</p>
    if (!items.length) return <div className="card muted">No mentor feedback yet. Join a review session from the sidebar, and your mentor's comments and suggested edits will appear here.</div>

    const activeAttempt = analysisId || items.reduce((max, f) => (f.attempt_number || 0) > (max?.attempt_number || 0) ? f : max, null)?.analysis_id
    const workflowOf = f => f.attempt_type === "cover_letter_only" ? "cover_letter" : "resume"
    const current = items.filter(f => f.status !== "dismissed" && f.analysis_id === activeAttempt && workflowOf(f) === tab)
    const previous = items
        .filter(f => (f.status === "dismissed" || f.analysis_id !== activeAttempt) && workflowOf(f) === tab)
        .sort((a, b) => parseTs(a.created_at) - parseTs(b.created_at))

    // an accepted section edit supersedes that section's bullets
    const supersededSections = new Set(
        items.filter(f => f.analysis_id === activeAttempt && f.feedback_type === "section_edit" && f.status === "accepted").map(f => f.section)
    )

    const FEEDBACK_TYPE_LABEL = { comment: "Comment", edit: "Bullet Edit", section_edit: "Section Edit" }

    function renderItem(f) {
        // superseded by a section edit kept for context only
        const superseded = f.feedback_type === "edit" && f.section && supersededSections.has(f.section)
        return <div className={`card feedback-item ${f.status} ${f.feedback_type === "section_edit" ? "feedback-item-section-edit" : ""} ${superseded ? "feedback-item-superseded" : ""}`} key={f.id}>
            <div className="feedback-meta">
                <b>{f.mentor_name}</b>
                <span className={`fw-badge ${f.feedback_type === "section_edit" ? "fw-badge-section-edit" : ""}`}>{f.feedback_type === "edit" && f.section === "Cover Letter" ? "Suggested Edit" : (FEEDBACK_TYPE_LABEL[f.feedback_type] || capitalize(f.feedback_type))}</span>
                {f.section && <span className="status-chip">{f.section}</span>}
                {f.status === "accepted" ? <span className="decision-flag accepted"><CheckCircle2 size={12} /> Accepted</span>
                    : f.status === "dismissed" ? <span className="decision-flag dismissed"><XCircle size={12} /> Dismissed</span>
                    : <span className={`status-chip status-${f.status}`}>{capitalize(f.status)}</span>}
                {f.attempt_number && <span className="feedback-attempt-meta">Attempt #{f.attempt_number} &bull; {formatShortDate(f.created_at)}</span>}
            </div>
            {/* the original stays struck through while the mentor's rewrite is the live
                proposal, and is restored the moment the rewrite is dismissed */}
            {(f.feedback_type === "edit" || f.feedback_type === "section_edit") && <DocumentDiff
                before={f.original_text} after={f.suggested_text}
                labelBefore={f.feedback_type === "section_edit" ? "Original section" : "Original"}
                labelAfter="Mentor's rewrite"
                className={f.status === "dismissed" ? "" : "original-superseded"}
            />}
            {f.comment && <p className="feedback-comment">{f.comment}</p>}
            {f.suggestion_key && f.suggestion_key.startsWith("cover_letter:") && <AnnotationThread analysisId={f.analysis_id} suggestionKey={`cover_letter_feedback:${f.id}`} section="Cover Letter" viewerRole="candidate" />}
            {superseded ? (
                <p className="feedback-superseded-note">Section was replaced by mentor rewrite. Please view the Tailored CV preview.</p>
            ) : f.status === "open" && <div className="composer-actions">
                <button className="btn-primary" disabled={busyId === f.id} onClick={() => setStatus(f.id, "accepted")}><Check size={15} /> Accept</button>
                <button className="btn-ghost" disabled={busyId === f.id} onClick={() => setStatus(f.id, "dismissed")}><X size={14} /> Dismiss</button>
            </div>}
        </div>
    }

    return <section>
        <h2 className="view-title">Mentor Feedback</h2>
        <div className="history-type-toggle">
            <button className={tab === "resume" ? "active" : ""} onClick={() => setTab("resume")}>Resume Analysis<NotificationBadge count={unreadByType.resume_analysis} /></button>
            <button className={tab === "cover_letter" ? "active" : ""} onClick={() => setTab("cover_letter")}>Cover Letters<NotificationBadge count={unreadByType.cover_letter_only} /></button>
        </div>
        <div className="feedback-list">
            {current.length ? current.map(renderItem) : <p className="muted">No feedback yet for your current attempt.</p>}
        </div>
        {previous.length > 0 && <details className="card previous-feedback">
            <summary>Previous Feedback ({previous.length})</summary>
            <div className="feedback-list">{previous.map(renderItem)}</div>
        </details>}
    </section>
}

// echo of analyser.py's kw_freqs, compare-resume-jd doesn't return per-kw counts
function kwFreqs(keywords, text) {
    const lower = (text || "").toLowerCase()
    const freqs = {}
    for (const kw of keywords) {
        const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const matches = lower.match(new RegExp(`\\b${escaped}\\b`, "g"))
        if (matches) freqs[kw] = matches.length
    }
    return freqs
}

function JobMatching({ result, provider, localEndpoint, jobMatch, setJobMatch, onReanalyse, onGenerateCV, onGenerateCoverLetter, analysing, busyAction }) {
    const { url, scraped, jobId, comparison, linkedinUrl, liProfile, company } = jobMatch
    const [compareBusy, setCompareBusy] = useState(false)
    const [scrapeBusy, setScrapeBusy] = useState(false)
    const [linkedinBusy, setLinkedinBusy] = useState(false)
    const [error, setError] = useState("")
    // a compare() in flight when a newer analysis lands mustn't overwrite it
    const curIdRef = useRef(result.analysis_id)
    useEffect(() => { curIdRef.current = result.analysis_id }, [result.analysis_id])

    function patch(fields) { setJobMatch(prev => ({ ...prev, ...fields })) }

    async function scrape() {
        setScrapeBusy(true)
        setError("")
        try {
            const res = await api.post("/scrape/jd", { url })
            patch({ scraped: res.data.text || "", jobId: res.data.job_id || null })
        } catch (err) { setError(getError(err)) } finally { setScrapeBusy(false) }
    }

    async function compare() {
        setError("")
        setCompareBusy(true)
        const reqId = result.analysis_id
        try {
            const res = await api.post("/scrape/compare", { resume_text: result.raw_text || "", jd_text: scraped || result.job_description || "", provider, local_endpoint: localEndpoint, job_id: jobId, analysis_id: result.analysis_id })
            if (reqId !== curIdRef.current) return // a newer analysis replaced this one while the request was in flight
            if (res.data.error) {
                setError(`Comparison failed: ${res.data.error}`)
                patch({ comparison: null })
            } else {
                patch({ comparison: res.data, company: res.data.company || "" })
            }
        } catch (err) {
            if (reqId !== curIdRef.current) return
            setError(getError(err))
        } finally { setCompareBusy(false) }
    }

    async function scrapeLinkedIn() {
        setLinkedinBusy(true)
        setError("")
        try {
            const res = await api.post("/scrape/linkedin", { url: linkedinUrl })
            patch({ liProfile: res.data.profile || res.data })
        } catch (err) { setError(getError(err)) } finally { setLinkedinBusy(false) }
    }

    const profileError = liProfile?.error
    const activeJD = scraped || result.job_description || ""
    const anyShortcutBusy = analysing || busyAction !== "" || compareBusy
    const matchedKeywordResult = comparison ? {
        jd_keywords: [...(comparison.strong_matches || []), ...(comparison.missing_skills || [])],
        missing_keywords: comparison.missing_skills || [],
        keyword_frequencies: kwFreqs(comparison.strong_matches || [], result.raw_text),
    } : null

    return <section className="job-matching-page">
        <h2 className="view-title">Job Matching</h2>
        <span className="section-label">Recruitment Integration</span>
        <div className="scrape-row">
            <input className="input-field" value={url} onChange={e => patch({ url: e.target.value })} placeholder="Enter Job Description URL" />
            <button className="job-match-action" onClick={scrape} disabled={scrapeBusy}>{scrapeBusy ? <><span className="spinner" />Scraping…</> : "Scrape"}</button>
        </div>
        {scraped && <textarea className="input-field document-editor" value={scraped} onChange={e => patch({ scraped: e.target.value })} />}
        {error && <p className="error-msg">{error}</p>}

        <button className="job-match-action job-match-compare" onClick={compare} disabled={compareBusy || (!scraped && !result.job_description)}>
            {compareBusy ? <><span className="spinner" />Comparing…</> : "Compare Resume to Job"}
        </button>

        {comparison && <div className="job-match-results">
            <div className="card job-match-score-card">
                <span className="section-label">Compatibility Score</span>
                <p className="metric-value">{comparison.match_pct || 0}%</p>
                <p><b>Strong matches:</b> {(comparison.strong_matches || []).join(", ") || "None"}</p>
                <p><b>Missing skills:</b> {(comparison.missing_skills || []).join(", ") || "None"}</p>
                <p><b>Tailoring tips:</b> {(comparison.tailoring_tips || []).join(" · ") || "None"}</p>
                {company && <p className="job-match-company"><Building2 size={13} /> {company}</p>}
            </div>

            <h3 className="doc-subhead">Matched Keyword Gap</h3>
            <KeywordGap result={matchedKeywordResult} />

            <div className="job-match-shortcuts">
                <button className="job-match-action" onClick={() => onReanalyse(activeJD)} disabled={anyShortcutBusy}>
                    {analysing ? <><span className="spinner" />Reanalysing…</> : <><RotateCw size={15} /> Reanalyse Resume</>}
                </button>
                <button className="job-match-action" onClick={() => onGenerateCV(activeJD)} disabled={anyShortcutBusy}>
                    {busyAction === "cv" ? <><span className="spinner" />Generating…</> : <><FileEdit size={15} /> Generate Tailored CV</>}
                </button>
                <button className="job-match-action" onClick={() => onGenerateCoverLetter(activeJD)} disabled={anyShortcutBusy}>
                    {busyAction === "cover-letter" ? <><span className="spinner" />Generating…</> : <><Mail size={15} /> Generate Cover Letter</>}
                </button>
            </div>
        </div>}

        <hr className="slim-divider" />
        <h3 className="doc-subhead">LinkedIn Profile Import</h3>
        <p className="muted">The reliable path is LinkedIn's own data export: Settings → Data privacy → Get a copy of your data → ZIP, then upload that ZIP in the main upload box. Public URL preview below is limited by LinkedIn's sign-in wall.</p>
        <div className="scrape-row">
            <input className="input-field" value={linkedinUrl} onChange={e => patch({ linkedinUrl: e.target.value })} placeholder="LinkedIn Profile URL (public preview only)" />
            <button className="btn-secondary" onClick={scrapeLinkedIn} disabled={linkedinBusy}>{linkedinBusy ? <><span className="spinner" />Loading…</> : "Preview Profile"}</button>
        </div>
        {liProfile && (profileError ? <p className="warning-strip">{profileError}</p> : <div className="card">{liProfile.name && <p><b>{liProfile.name}</b></p>}{liProfile.headline && <p>{liProfile.headline}</p>}{liProfile.note && <p className="muted">{liProfile.note}</p>}</div>)}
    </section>
}

// remembered across reloads so auto-collapse stops fighting them
const SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY = "rtr_sidebar_auto_collapse_disabled"

function fileSafe(s) {
    return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "DOCUMENT"
}

function App() {
    const { user, logout } = useAuth()
    const [provider, setProvider] = useState("default")
    const [useCritic, setUseCritic] = useState(false)
    const [localEndpoint, setLocalEndpoint] = useState("http://localhost:11434/api/chat")
    const [status, setStatus] = useState({})
    const [apiKey, setApiKey] = useState("")
    const [keyBusy, setKeyBusy] = useState(false)
    const [keyMessage, setKeyMessage] = useState("")
    const [file, setFile] = useState(null)
    const [jobDescription, setJobDescription] = useState("")
    const [result, setResult] = useState(null)
    const [analysisId, setAnalysisId] = useState(null)
    const [decisions, setDecisions] = useState({})
    const [docs, setDocs] = useState({ cv: "", cover_letter: "" })
    const [view, setView] = useState("Suggestions")
    const [busy, setBusy] = useState(false)
    // separate from the full analysis the two halves are very different requests
    const [quickBusy, setQuickBusy] = useState(false)
    const [error, setError] = useState("")
    const [history, setHistory] = useState([])
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
    const [autoCollapseDisabled, setAutoCollapseDisabled] = useState(() => localStorage.getItem(SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY) === "true")
    const [exported, setExported] = useState(false)
    const [setupExpanded, setSetupExpanded] = useState(true)
    // browse history with no attempt yet straight from persisted data
    const [historyOnly, setHistoryOnly] = useState(false)
    // lifted out of JobMatching
    const [jobMatch, setJobMatch] = useState({ url: "", scraped: "", jobId: null, comparison: null, linkedinUrl: "", liProfile: null, company: "" })
    const [jmBusy, setJmBusy] = useState("")
    const autoCollapsedRef = useRef(false)
    // openHistoryAttempt setFile()s the old resume just for the pdf
    const restoringRef = useRef(false)
    const [notifSummary, refreshNotifs] = useNotifSummary(!!user)
    // fires on any attempt change, a no-op on a fresh one
    useEffect(() => {
        if (!analysisId) return
        api.post("/notifications/mark-read", { analysis_id: analysisId }).then(refreshNotifs).catch(() => {})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [analysisId])
    const providerMeta = PROVIDER_OPTIONS.find(p => p.key === provider)
    const visibleProviders = PROVIDER_OPTIONS.filter(p => p.key !== "local" || status.localAllowed)
    const needsKey = providerMeta?.byok && status[provider] === false
    const fullName = result?.parsed_resume?.contact?.name || result?.contact?.name || ""
    const isCoverLetterOnlyAttempt = result?.attempt_type === "cover_letter_only"

    function refreshStatus() {
        return api.get("/settings/env-status").then(res => setStatus(res.data)).catch(() => setStatus({}))
    }

    useEffect(() => {
        if (!user) return
        refreshStatus()
        api.get("/analysis/history").then(res => setHistory(res.data)).catch(() => setHistory([]))
    }, [user])

    // the browser scrolls a focused field into view
    const focusedAtRef = useRef(false)
    useEffect(() => {
        let timer = null
        function onFocusIn(e) {
            const tag = (e.target.tagName || "").toLowerCase()
            if (tag !== "input" && tag !== "textarea" && tag !== "select") return
            focusedAtRef.current = true
            clearTimeout(timer)
            timer = setTimeout(() => { focusedAtRef.current = false }, 600)
        }
        window.addEventListener("focusin", onFocusIn)
        return () => { window.removeEventListener("focusin", onFocusIn); clearTimeout(timer) }
    }, [])

    // collapse once per session at ~20%
    useEffect(() => {
        if (!result || autoCollapseDisabled) return undefined
        function onScroll() {
            if (focusedAtRef.current) return
            if (autoCollapsedRef.current) return
            const pageHeight = document.documentElement.scrollHeight
            if (window.scrollY > pageHeight * 0.2) {
                autoCollapsedRef.current = true
                setSidebarCollapsed(true)
            }
        }
        window.addEventListener("scroll", onScroll, { passive: true })
        return () => window.removeEventListener("scroll", onScroll)
    }, [result, autoCollapseDisabled])

    function toggleSidebar() {
        setSidebarCollapsed(prev => {
            const next = !prev
            // expanding is the signal they want control
            if (prev && !next && !autoCollapseDisabled) {
                setAutoCollapseDisabled(true)
                localStorage.setItem(SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY, "true")
            }
            return next
        })
    }

    useEffect(() => {
        if (restoringRef.current) return
        setResult(null)
        setAnalysisId(null)
        setDecisions({})
        setDocs({ cv: "", cover_letter: "" })
        setKeyMessage("")
    }, [provider, useCritic, file])

    async function saveKey() {
        setKeyBusy(true)
        setKeyMessage("")
        try {
            await api.post("/settings/api-key", { provider, key: apiKey })
            setStatus({ ...status, [provider]: true })
            setApiKey("")
        } catch (err) { setKeyMessage(getError(err)) } finally { setKeyBusy(false) }
    }

    async function removeKey() {
        setKeyBusy(true)
        setKeyMessage("")
        try {
            await api.delete(`/settings/api-key/${provider}`)
            setStatus({ ...status, [provider]: false })
        } catch (err) { setKeyMessage(getError(err)) } finally { setKeyBusy(false) }
    }

    // jdOverride reruns against job matching's scraped jd
    async function analyse(jdOverride, { landOn = "Suggestions" } = {}) {
        if (!file) return null
        const jd = jdOverride !== undefined ? jdOverride : jobDescription
        setBusy(true)
        setError("")
        try {
            const data = new FormData()
            data.append("file", file)
            const upload = await api.post("/analysis/upload", data)
            const run = await api.post("/analysis/run", {
                resume_id: upload.data.resume_id,
                resume_json: upload.data.parsed,
                job_description: jd,
                provider,
                use_critic: useCritic,
                local_endpoint: provider === "local" ? localEndpoint : "",
            })
            const completed = await pollJob(run.data.job_id)
            const newResult = { ...completed, parsed_resume: upload.data.parsed, job_description: jd, raw_text: upload.data.parsed.raw_text }
            setResult(newResult)
            setAnalysisId(completed.analysis_id)
            setDecisions({})
            if (landOn) setView(landOn)
            setSidebarCollapsed(false)
            setSetupExpanded(false)
            setExported(false)
            // only sync an override back 
            if (jdOverride !== undefined) setJobDescription(jd)
            autoCollapsedRef.current = false
            // restore docs already generated for this analysis so tabs don't wipe them
            try {
                const docsRes = await api.get(`/generate/latest?analysis_id=${completed.analysis_id}`)
                setDocs({
                    cv: docsRes.data.cv?.content || "",
                    cover_letter: docsRes.data.cover_letter?.content || "",
                })
            } catch { setDocs({ cv: "", cover_letter: "" }) }
            const hist = await api.get("/analysis/history")
            setHistory(hist.data)
            return { analysisId: completed.analysis_id, result: newResult }
        } catch (err) { setError(getError(err)); return null } finally { setBusy(false) }
    }

    // not analyse()'s path one synchronous llm call
    async function generateCoverLetterOnly() {
        if (!file) return null
        setQuickBusy(true)
        setError("")
        try {
            const data = new FormData()
            data.append("file", file)
            const upload = await api.post("/analysis/upload", data)
            const gen = await api.post("/analysis/quick-cover-letter", {
                resume_id: upload.data.resume_id,
                resume_json: upload.data.parsed,
                job_description: jobDescription,
                provider,
                local_endpoint: provider === "local" ? localEndpoint : "",
            })
            const newResult = {
                ...gen.data.results, parsed_resume: upload.data.parsed, job_description: jobDescription, raw_text: upload.data.parsed.raw_text,
                keyword_frequencies: kwFreqs(gen.data.results.strong_matches || [], upload.data.parsed.raw_text),
            }
            setResult(newResult)
            setAnalysisId(gen.data.analysis_id)
            setDecisions({})
            setDocs({ cv: "", cover_letter: gen.data.cover_letter_text || "" })
            setView("Cover Letter")
            setSidebarCollapsed(false)
            setSetupExpanded(false)
            setExported(false)
            autoCollapsedRef.current = false
            const hist = await api.get("/analysis/history")
            setHistory(hist.data)
            return { analysisId: gen.data.analysis_id, result: newResult }
        } catch (err) { setError(getError(err)); return null } finally { setQuickBusy(false) }
    }

    // lands a past attempt like a fresh one incl the exact resume it came from
    async function openHistoryAttempt(id) {
        setError("")
        restoringRef.current = true
        try {
            const res = await api.get(`/analysis/${id}`)
            const resultsData = res.data.results || {}
            const newResult = {
                ...resultsData,
                attempt_type: res.data.attempt_type,
                analysis_id: res.data.id,
                resume_id: res.data.resume_id,
                raw_text: resultsData.raw_text || resultsData.parsed_resume?.raw_text || "",
            }
            // never persisted for these so need to derive 
            if (!newResult.keyword_frequencies && newResult.strong_matches) {
                newResult.keyword_frequencies = kwFreqs(newResult.strong_matches, newResult.raw_text)
            }

            try {
                const resumesList = await api.get("/analysis/resumes")
                const meta = resumesList.data.find(r => r.id === res.data.resume_id)
                const filename = meta?.filename || "resume"
                const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
                const fileRes = await api.get(`/analysis/resumes/${res.data.resume_id}/file`, { responseType: "blob" })
                setFile(new File([fileRes.data], filename, { type: RESUME_EXT_MIME[ext] || "application/octet-stream" }))
            } catch { /* the rest of the workspace still works without the source file preview */ }

            setResult(newResult)
            setAnalysisId(res.data.id)
            setJobDescription(newResult.job_description || "")
            let decisionsData = {}
            try { decisionsData = (await api.get(`/analysis/${id}/decisions`)).data } catch { /* leave empty */ }
            setDecisions(decisionsData)
            try {
                const docsRes = await api.get(`/generate/latest?analysis_id=${id}`)
                setDocs({ cv: docsRes.data.cv?.content || "", cover_letter: docsRes.data.cover_letter?.content || "" })
            } catch { setDocs({ cv: "", cover_letter: "" }) }
            setView(res.data.attempt_type === "cover_letter_only" ? "Cover Letter" : "Suggestions")
            setSidebarCollapsed(false)
            setSetupExpanded(false)
            setExported(false)
            autoCollapsedRef.current = false
        } catch (err) { setError(getError(err)) } finally { restoringRef.current = false }
    }

    // jd-only, so nothing reruns
    async function refreshJobDescription(jdText, { company: companyOverride } = {}) {
        const id = analysisId || result?.analysis_id
        if (!id) return { ok: false, error: "No active attempt to update." }
        try {
            const payload = { job_description: jdText, provider, local_endpoint: localEndpoint }
            const companyToSend = companyOverride ?? jobMatch.company
            if (companyToSend) payload.company = companyToSend
            const res = await api.post(`/analysis/${id}/refresh-jd`, payload)
            const updated = {
                ...result,
                ...res.data.results,
                keyword_frequencies: kwFreqs(res.data.results.strong_matches || [], result.raw_text),
            }
            setResult(updated)
            setDocs(prev => ({ ...prev, cover_letter: res.data.cover_letter_text || "" }))
            setJobDescription(jdText)
            return { ok: true }
        } catch (err) {
            return { ok: false, error: getError(err) }
        }
    }

    // the scraped jd goes active but nothing about the attempt is rerun
    async function generateCoverLetterFromJobMatch(jdText) {
        setJmBusy("cover-letter")
        try {
            const { ok, error } = await refreshJobDescription(jdText)
            if (ok) {
                toast("Cover letter generated from Job Matching")
                setView("Cover Letter")
            } else {
                toast(error, "error")
            }
        } finally {
            setJmBusy("")
        }
    }

    // the one place a job matching jd replaces the whole attempt
    async function generateCVFromJobMatch(jdText) {
        setJmBusy("cv")
        try {
            const landed = await analyse(jdText, { landOn: null })
            if (!landed) return // analyse() already surfaced the error
            const acceptAll = Object.fromEntries(
                Object.entries(landed.result.rewrites || {}).flatMap(([, items]) => items.map(item => [item.id, true]))
            )
            await api.post(`/analysis/${landed.analysisId}/decisions`, { decisions: acceptAll })
            setDecisions(acceptAll)
            const res = await api.post("/generate/cv", {
                resume_json: landed.result.parsed_resume,
                job_description: jdText,
                provider, local_endpoint: localEndpoint,
                analysis_id: landed.analysisId,
                rewrite_suggestions: landed.result.rewrites,
                rewrite_decisions: acceptAll,
                acc_map: {},
            })
            setDocs({ cv: res.data.cv_text, cover_letter: "" })
            toast("New attempt analysed and Tailored CV generated from Job Matching")
            setView("Tailored CV")
        } catch (err) {
            toast(getError(err), "error")
        } finally {
            setJmBusy("")
        }
    }

    if (!user) return <AuthPage />
    const isMentor = user.role === "mentor"

    // mentors land in their workspace
    if (isMentor) {
        return <main className="app-container">
            <ToastHost />
            <AuthBar user={user} onLogout={logout} />
            <Hero />
            <div className="topbar">
                <span className="muted">Signed in as <b>{user.display_name}</b> · mentor</span>
                <button className="btn-secondary" onClick={logout}>Sign out</button>
            </div>
            <MentorDashboard />
        </main>
    }

    return <main className="app-container">
        <ToastHost />
        <AuthBar user={user} onLogout={logout} />
        <Hero />
        <PipelineStepper file={file} busy={busy} result={result} docs={docs} exported={exported} />
        {!historyOnly && (result && !setupExpanded ? (
            <button className="setup-summary" onClick={() => setSetupExpanded(true)}>
                <UploadCloud size={15} />
                <span className="setup-summary-name">{file?.name || "Resume analysed"}</span>
                <span className="setup-summary-hint muted">Change resume, job description, or provider</span>
            </button>
        ) : <>
            <div className="model-bar">
                <label>AI Provider
                    <select className="input-field" value={provider} onChange={e => setProvider(e.target.value)}>
                        {visibleProviders.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                    </select>
                </label>
                <label className="toggle-wrap"><span className={`toggle-track ${useCritic ? "active" : ""}`} onClick={() => setUseCritic(!useCritic)}><span className="toggle-thumb" /></span>Agentic Self-Correction</label>
                {provider === "local" && <div className="local-endpoint-field">
                    <input className="input-field" value={localEndpoint} onChange={e => setLocalEndpoint(e.target.value)} placeholder="Local API Endpoint" />
                    <small className="muted">Must be reachable by the server, not just your browser. Defaults to your machine's Ollama if you're running this app locally — for a hosted deployment, expose your local model with a tunnel (e.g. ngrok, Tailscale Funnel, Cloudflare Tunnel) and paste that URL here.</small>
                </div>}
                {/* nothing worth showing under "Signed in as" before any analysis exists, a
                    way back into past attempts is more use here */}
                {!result && <span className="topbar-inline">
                    <button className="btn-secondary" onClick={() => setHistoryOnly(true)}><History size={13} /> View Past Attempts<NotificationBadge count={notifSummary.unread_total} /></button>
                    <button className="btn-secondary" onClick={logout}>{user.is_guest ? <><LogIn size={13} /> Sign In</> : <><LogOut size={13} /> Sign out</>}</button>
                </span>}
            </div>
            {providerMeta?.byok && <div className="card key-card">
                <span className="section-label"><KeyRound size={13} /> {providerMeta.label.replace(" (Own Key)", "")} API Key</span>
                {status[provider]
                    ? <>
                        <p className="muted">A key is saved for your account and will be used for your requests only.</p>
                        <button className="btn-destructive" disabled={keyBusy} onClick={removeKey}>Remove key</button>
                    </>
                    : <>
                        <p className="muted">Add your own key to use {providerMeta.label.replace(" (Own Key)", "")} — it's encrypted and tied to your account, used only for your own requests, never shared with other users.</p>
                        <div className="two-col">
                            <input className="input-field" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={`Paste your ${providerMeta.label.replace(" (Own Key)", "")} API key`} />
                            <button className="btn-primary" disabled={keyBusy || !apiKey.trim()} onClick={saveKey}>Save Key</button>
                        </div>
                    </>}
                {keyMessage && <p className="error-msg">{keyMessage}</p>}
            </div>}
            <ResumeSetup file={file} setFile={setFile} jobDescription={jobDescription} setJobDescription={setJobDescription} onAnalyse={analyse} onQuickCoverLetter={generateCoverLetterOnly} busy={busy || needsKey} quickBusy={quickBusy || needsKey} />
            {needsKey && <p className="warning-strip">Add a {providerMeta.label.replace(" (Own Key)", "")} API key above, or switch to Default (Free), before analysing.</p>}
            {result && <div className="setup-collapse-row"><button className="btn-ghost" onClick={() => setSetupExpanded(false)}>Hide setup</button></div>}
        </>)}
        {error && <p className="warning-strip">{error}</p>}
        {!result && !historyOnly && <details className="card"><summary>Mentor Feedback &amp; Review Sessions<NotificationBadge count={notifSummary.unread_total} /></summary><div className="prelim-panels"><SessionJoin /><FeedbackInbox unreadByType={notifSummary.by_attempt_type} onDocumentAccepted={(documentType, text) => setDocs(d => ({ ...d, [documentType]: text }))} /></div></details>}
        {!result && historyOnly && <section className="mentor-workspace">
            <div className="detail-head">
                <button className="btn-secondary" onClick={() => setHistoryOnly(false)}>← Back</button>
                <h3 className="detail-title">Attempt History</h3>
            </div>
            <AttemptHistory history={history} onOpenAttempt={id => { setHistoryOnly(false); openHistoryAttempt(id) }} unreadById={notifSummary.by_analysis_id} />
        </section>}
        {result && <>
            <TopNav view={view} setView={setView} badges={{ "Attempt History": notifSummary.unread_total, "Mentor Feedback": notifSummary.unread_total }} />
            <div className={`workspace ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
            <ResultsSidebar result={result} user={user} onLogout={logout} history={history} collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />
            <div className="workspace-main">
                <div className="fade-in" key={view}>
                    {view === "Suggestions" && (isCoverLetterOnlyAttempt
                        ? <><h2 className="view-title">Review Suggestions</h2><AnalysisRequiredGate icon={MessageSquareText} busy={busy} message="This attempt only generated a Cover Letter - run a full analysis on the same resume to get rewrite suggestions." onAnalyse={() => analyse(undefined, { landOn: "Suggestions" })} /></>
                        : <RewriteReview result={result} file={file} decisions={decisions} setDecisions={setDecisions} analysisId={analysisId} />)}
                    {view === "Keyword Gap" && <KeywordGap result={result} />}
                    {view === "Extracted Sections" && <ExtractedSections result={result} />}
                    {view === "Tailored CV" && (isCoverLetterOnlyAttempt
                        ? <><h2 className="view-title">Generate Tailored CV</h2><AnalysisRequiredGate icon={FileEdit} busy={busy} message="A Tailored CV is built from rewrite suggestions, which need a full resume analysis first." onAnalyse={() => analyse(undefined, { landOn: "Tailored CV" })} /></>
                        : <DocumentGenerator type="cv" result={result} provider={provider} localEndpoint={localEndpoint} decisions={decisions} analysisId={analysisId} text={docs.cv} setText={t => setDocs({ ...docs, cv: t })} onExport={() => setExported(true)} fullName={fullName} />)}
                    {view === "Cover Letter" && <DocumentGenerator type="cover-letter" result={result} provider={provider} localEndpoint={localEndpoint} decisions={decisions} analysisId={analysisId} text={docs.cover_letter} setText={t => setDocs({ ...docs, cover_letter: t })} onExport={() => setExported(true)} fullName={fullName} company={jobMatch.company} onChangeJobDescription={refreshJobDescription} />}
                    {view === "Mentor Feedback" && <FeedbackInbox analysisId={analysisId || result?.analysis_id} attemptType={result?.attempt_type} unreadByType={notifSummary.by_attempt_type} onDocumentAccepted={(documentType, text) => setDocs(d => ({ ...d, [documentType]: text }))} />}
                    {view === "Insights" && (isCoverLetterOnlyAttempt
                        ? <><h2 className="view-title">Insights</h2><AnalysisRequiredGate icon={BarChart3} busy={busy} message="Score trends, ATS match, and section-strength insights need a full resume analysis." onAnalyse={() => analyse(undefined, { landOn: "Insights" })} /></>
                        : <Insights result={result} history={history} decisions={decisions} />)}
                    {view === "Attempt History" && <AttemptHistory history={history} onOpenAttempt={openHistoryAttempt} unreadById={notifSummary.by_analysis_id} />}
                    {view === "Job Matching" && <JobMatching
                        result={result} provider={provider} localEndpoint={localEndpoint}
                        jobMatch={jobMatch} setJobMatch={setJobMatch}
                        onReanalyse={jd => analyse(jd)}
                        onGenerateCV={jd => generateCVFromJobMatch(jd)}
                        onGenerateCoverLetter={jd => generateCoverLetterFromJobMatch(jd)}
                        analysing={busy}
                        busyAction={jmBusy}
                    />}
                </div>
            </div>
            </div>
        </>}
    </main>
}

export default App
