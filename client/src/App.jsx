import { useEffect, useRef, useState } from "react"
import { BarChart3, FileEdit, History, KeyRound, LogIn, LogOut, MessageSquareText, UploadCloud } from "lucide-react"
import api from "./api/client"
import { pollJob } from "./api/jobs"
import { streamAnalysis } from "./api/stream"
import { useAuth } from "./context/AuthContext"
import { useNotifSummary } from "./hooks/useNotifSummary"
import { getError } from "./lib/errors"
import { RESUME_EXT_MIME } from "./lib/files"
import { kwFreqs } from "./lib/keywords"
import { isActionable, isFlagged } from "./lib/review"
import { ToastHost, toast } from "./components/Toast"
import { NotificationBadge } from "./components/NotificationBadge"
import { AnalysisRequiredGate } from "./components/AnalysisRequiredGate"
import { AuthBar, Hero, PipelineStepper, TopNav } from "./components/AppChrome"
import { SessionJoin } from "./components/SessionJoin"
import { AuthPage } from "./views/AuthPage"
import { ResumeSetup } from "./views/candidate/ResumeSetup"
import { AnalysisProgress, advanceProgress } from "./views/candidate/AnalysisProgress"
import { ResultsSidebar } from "./views/candidate/ResultsSidebar"
import { AttemptHistory } from "./views/candidate/AttemptHistory"
import { RewriteReview } from "./views/candidate/RewriteReview"
import { KeywordGap } from "./views/candidate/KeywordGap"
import { ExtractedSections } from "./views/candidate/ExtractedSections"
import { DocumentGenerator } from "./views/candidate/DocumentGenerator"
import { Insights } from "./views/candidate/Insights"
import { FeedbackInbox } from "./views/candidate/FeedbackInbox"
import { JobMatching } from "./views/candidate/JobMatching"
import { MentorDashboard } from "./views/mentor/MentorDashboard"

// model is fixed per provider server-side now UI only picks the provider
const PROVIDER_OPTIONS = [
    { key: "default", label: "Default (Free)", byok: false },
    { key: "gemini", label: "Gemini (Own Key)", byok: true },
    { key: "claude", label: "Claude (Own Key)", byok: true },
    { key: "chatgpt", label: "ChatGPT (Own Key)", byok: true },
    { key: "local", label: "Local LLM", byok: false },
    { key: "demo", label: "Demo (offline sample answers)", byok: false },
]

// remembered across reloads so auto-collapse stops fighting them
const SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY = "rtr_sidebar_auto_collapse_disabled"

// streamed so suggestions arrive batch by batch. /run and polling stay for a browser
// that can't read a response body as it arrives
async function runAnalysis(body, onEvent) {
    try {
        return await streamAnalysis(body, onEvent)
    } catch (err) {
        if (!String(err.message).includes("Streaming is not supported")) throw err
        const run = await api.post("/analysis/run", body)
        return await pollJob(run.data.job_id)
    }
}

// streamed rewrites arrive a batch at a time, in whatever order the batches finish.
// grouped back into resume order so a half-finished review still reads top to bottom
function groupRewrites(items, sections) {
    const grouped = {}
    for (const section of Object.keys(sections || {})) grouped[section] = []
    for (const item of items) (grouped[item.section] = grouped[item.section] || []).push(item)
    for (const list of Object.values(grouped)) list.sort((a, b) => (a.line_indices?.[0] ?? 0) - (b.line_indices?.[0] ?? 0))
    return grouped
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
    // the stages the engine has reported, while an analysis runs
    const [progress, setProgress] = useState(null)
    // decisions made before the analysis finished get saved once it has an id
    const decisionsRef = useRef(decisions)
    useEffect(() => { decisionsRef.current = decisions }, [decisions])
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
    const visibleProviders = PROVIDER_OPTIONS.filter(p => (p.key !== "local" || status.localAllowed) && (p.key !== "demo" || status.demo))
    const needsKey = providerMeta?.byok && status[provider] === false
    const fullName = result?.parsed_resume?.contact?.name || result?.contact?.name || ""
    const isCoverLetterOnlyAttempt = result?.attempt_type === "cover_letter_only"
    // suggestions are streaming in but nothing else exists yet
    const pending = !!result?.partial

    function refreshStatus() {
        return api.get("/settings/env-status").then(res => {
            setStatus(res.data)
            // no key for the free tier: start on the offline demo instead of a dead option
            if (res.data.default === false && res.data.demo) setProvider(p => (p === "default" ? "demo" : p))
        }).catch(() => setStatus({}))
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
        setResult(null)
        setAnalysisId(null)
        setDecisions({})
        setProgress({ stage: "uploading", startedAt: Date.now(), withJd: Boolean(jd.trim()) })
        try {
            const data = new FormData()
            data.append("file", file)
            const upload = await api.post("/analysis/upload", data)
            const parsed = upload.data.parsed
            const base = { parsed_resume: parsed, job_description: jd, raw_text: parsed.raw_text }
            const streamed = []
            const completed = await runAnalysis({
                resume_id: upload.data.resume_id,
                job_description: jd,
                provider,
                use_critic: useCritic,
                local_endpoint: provider === "local" ? localEndpoint : "",
            }, event => {
                setProgress(prev => advanceProgress(prev, event))
                if (event.stage !== "chunk" || !event.rewrites?.length) return
                const first = !streamed.length
                streamed.push(...event.rewrites)
                // the review opens on the first batch and fills in as the rest land
                setResult({ ...base, contact: parsed.contact, sections: parsed.sections, rewrites: groupRewrites(streamed, parsed.sections), partial: true })
                if (first) {
                    if (landOn) setView(landOn)
                    setSetupExpanded(false)
                }
            })
            const newResult = { ...completed, ...base }
            setResult(newResult)
            setAnalysisId(completed.analysis_id)
            const early = decisionsRef.current
            if (Object.keys(early).length) {
                api.post(`/analysis/${completed.analysis_id}/decisions`, { decisions: early }).catch(() => {})
            }
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
        } catch (err) { setError(getError(err)); return null } finally { setBusy(false); setProgress(null) }
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
            const updated = { ...result, ...res.data.results }
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
            // flagged rewrites claim what the original doesn't, so they stay out of a
            // cv nobody has reviewed yet
            const items = Object.values(landed.result.rewrites || {}).flat().filter(isActionable)
            const flagged = items.filter(isFlagged).length
            const acceptAll = Object.fromEntries(items.filter(item => !isFlagged(item)).map(item => [item.id, true]))
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
            toast(flagged
                ? `Tailored CV generated. ${flagged} flagged suggestion${flagged === 1 ? " was" : "s were"} left out, review ${flagged === 1 ? "it" : "them"} under Suggestions`
                : "New attempt analysed and Tailored CV generated from Job Matching")
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
        {progress && <AnalysisProgress progress={progress} />}
        {!result && !historyOnly && !busy && <details className="card"><summary>Mentor Feedback &amp; Review Sessions<NotificationBadge count={notifSummary.unread_total} /></summary><div className="prelim-panels"><SessionJoin /><FeedbackInbox unreadByType={notifSummary.by_attempt_type} onDocumentAccepted={(documentType, text) => setDocs(d => ({ ...d, [documentType]: text }))} /></div></details>}
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
                    {pending && view !== "Suggestions" && view !== "Extracted Sections" && <div className="card muted">This fills in when the analysis finishes. Suggestions are already arriving under Suggestions.</div>}
                    {!pending && <>
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
                    </>}
                    {pending && view === "Suggestions" && <RewriteReview result={result} file={file} decisions={decisions} setDecisions={setDecisions} analysisId={null} pending />}
                    {pending && view === "Extracted Sections" && <ExtractedSections result={result} />}
                </div>
            </div>
            </div>
        </>}
    </main>
}

export default App
