import { useEffect, useRef, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { ArrowLeft, BarChart3, FileEdit, History, KeyRound, MessageSquareText } from "lucide-react"
import api from "./api/client"
import { pollJob } from "./api/jobs"
import { streamAnalysis } from "./api/stream"
import { useAuth } from "./context/AuthContext"
import { useNotifSummary } from "./hooks/useNotifSummary"
import { getError } from "./lib/errors"
import { RESUME_EXT_MIME } from "./lib/files"
import { kwFreqs } from "./lib/keywords"
import { isActionable, isFlagged } from "./lib/review"
import { attemptPath, readPath } from "./lib/routes"
import { ToastHost, toast } from "./components/Toast"
import { NotificationBadge } from "./components/NotificationBadge"
import { AnalysisRequiredGate } from "./components/AnalysisRequiredGate"
import { AppHeader, PipelineStepper, SubNav, TopNav } from "./components/AppChrome"
import { SessionJoin } from "./components/SessionJoin"
import { Landing } from "./views/Landing"
import { ResumeSetup } from "./views/candidate/ResumeSetup"
import { AnalysisProgress, advanceProgress } from "./views/candidate/AnalysisProgress"
import { ParsePreview } from "./views/candidate/ParsePreview"
import { ResultsSidebar } from "./views/candidate/ResultsSidebar"
import { AttemptHistory } from "./views/candidate/AttemptHistory"
import { RewriteReview } from "./views/candidate/RewriteReview"
import { ExtractedSections } from "./views/candidate/ExtractedSections"
import { DocumentGenerator } from "./views/candidate/DocumentGenerator"
import { Insights } from "./views/candidate/Insights"
import { FeedbackInbox } from "./views/candidate/FeedbackInbox"
import { JobFit } from "./views/candidate/JobFit"
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

function readFlag(key) {
    try { return localStorage.getItem(key) === "true" } catch { return false }
}

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
    const location = useLocation()
    const navigate = useNavigate()
    const route = readPath(location.pathname)
    const [provider, setProvider] = useState("default")
    const [useCritic, setUseCritic] = useState(false)
    const [localEndpoint, setLocalEndpoint] = useState("http://localhost:11434/api/chat")
    const [status, setStatus] = useState({})
    const [statusLoaded, setStatusLoaded] = useState(false)
    const [apiKey, setApiKey] = useState("")
    const [keyBusy, setKeyBusy] = useState(false)
    const [keyMessage, setKeyMessage] = useState("")
    const [file, setFile] = useState(null)
    // the file uploads and parses as soon as it's picked: { file, status, resumeId, parsed }
    const [upload, setUpload] = useState(null)
    const uploadRef = useRef(null)
    const [jobDescription, setJobDescription] = useState("")
    const [result, setResult] = useState(null)
    const [analysisId, setAnalysisId] = useState(null)
    const [decisions, setDecisions] = useState({})
    const [docs, setDocs] = useState({ cv: "", cover_letter: "" })
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
    const [autoCollapseDisabled, setAutoCollapseDisabled] = useState(() => readFlag(SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY))
    const [exported, setExported] = useState(false)
    // lifted out of JobMatching
    const [jobMatch, setJobMatch] = useState({ url: "", scraped: "", jobId: null, comparison: null, linkedinUrl: "", liProfile: null, company: "" })
    const [jmBusy, setJmBusy] = useState("")
    const autoCollapsedRef = useRef(false)
    // openHistoryAttempt setFile()s the old resume just for the pdf
    const restoringRef = useRef(false)
    const [notifSummary, refreshNotifs] = useNotifSummary(!!user)
    const attemptId = analysisId || result?.analysis_id || null
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
        }).catch(() => setStatus({})).finally(() => setStatusLoaded(true))
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
                try { localStorage.setItem(SIDEBAR_AUTO_COLLAPSE_DISABLED_KEY, "true") } catch { /* only a preference */ }
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

    // one upload per file. the server keys it on the bytes, so the same file again
    // is a lookup, not a second parse
    function startUpload(picked) {
        const data = new FormData()
        data.append("file", picked)
        const entry = { file: picked, failed: false }
        entry.promise = api.post("/analysis/upload", data).then(res => {
            const done = { file: picked, status: "done", resumeId: res.data.resume_id, parsed: res.data.parsed }
            if (uploadRef.current === entry) setUpload(done)
            return done
        }, err => {
            entry.failed = true
            if (uploadRef.current === entry) setUpload({ file: picked, status: "failed", error: getError(err) })
            throw err
        })
        uploadRef.current = entry
        setUpload({ file: picked, status: "uploading" })
        return entry.promise
    }

    // the upload for a file, retried if it failed
    function uploaded(target = file) {
        const entry = uploadRef.current
        if (entry?.file === target && !entry.failed) return entry.promise
        return startUpload(target)
    }

    useEffect(() => {
        if (!file) { uploadRef.current = null; setUpload(null); return }
        if (uploadRef.current?.file !== file) startUpload(file).catch(() => {})
    }, [file])

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

    // jdOverride reruns against job matching's scraped jd. the review opens on the
    // first streamed batch, at /attempts/new/..., and the url gets the id once it's saved
    async function analyse(jdOverride, { landOn = { tab: "review" }, fileOverride, providerOverride } = {}) {
        const target = fileOverride || file
        if (!target) return null
        const jd = jdOverride !== undefined ? jdOverride : jobDescription
        const chosen = providerOverride || provider
        setBusy(true)
        setError("")
        setResult(null)
        setAnalysisId(null)
        setDecisions({})
        setProgress({ stage: "uploading", startedAt: Date.now(), withJd: Boolean(jd.trim()) })
        try {
            const { resumeId, parsed } = await uploaded(target)
            const base = { parsed_resume: parsed, job_description: jd, raw_text: parsed.raw_text }
            const streamed = []
            const completed = await runAnalysis({
                resume_id: resumeId,
                job_description: jd,
                provider: chosen,
                use_critic: useCritic,
                local_endpoint: chosen === "local" ? localEndpoint : "",
            }, event => {
                setProgress(prev => advanceProgress(prev, event))
                if (event.stage !== "chunk" || !event.rewrites?.length) return
                const first = !streamed.length
                streamed.push(...event.rewrites)
                // the review opens on the first batch and fills in as the rest land
                setResult({ ...base, contact: parsed.contact, sections: parsed.sections, rewrites: groupRewrites(streamed, parsed.sections), partial: true })
                if (first && landOn) navigate(attemptPath(null, landOn.tab, landOn.sub))
            })
            const newResult = { ...completed, ...base }
            setResult(newResult)
            setAnalysisId(completed.analysis_id)
            const early = decisionsRef.current
            if (Object.keys(early).length) {
                api.post(`/analysis/${completed.analysis_id}/decisions`, { decisions: early }).catch(() => {})
            }
            // the streamed attempt's url takes its id, on whichever tab is open now
            const here = readPath(window.location.pathname)
            if (here.screen === "attempt" && here.id === null) navigate(attemptPath(completed.analysis_id, here.tab, here.sub), { replace: true })
            else if (landOn) navigate(attemptPath(completed.analysis_id, landOn.tab, landOn.sub))
            setSidebarCollapsed(false)
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
            const { resumeId, parsed } = await uploaded()
            const gen = await api.post("/analysis/quick-cover-letter", {
                resume_id: resumeId,
                resume_json: parsed,
                job_description: jobDescription,
                provider,
                local_endpoint: provider === "local" ? localEndpoint : "",
            })
            const newResult = {
                ...gen.data.results, parsed_resume: parsed, job_description: jobDescription, raw_text: parsed.raw_text,
            }
            setResult(newResult)
            setAnalysisId(gen.data.analysis_id)
            setDecisions({})
            setDocs({ cv: "", cover_letter: gen.data.cover_letter_text || "" })
            navigate(attemptPath(gen.data.analysis_id, "documents", "cover-letter"))
            setSidebarCollapsed(false)
            setExported(false)
            autoCollapsedRef.current = false
            const hist = await api.get("/analysis/history")
            setHistory(hist.data)
            return { analysisId: gen.data.analysis_id, result: newResult }
        } catch (err) { setError(getError(err)); return null } finally { setQuickBusy(false) }
    }

    // lands a past attempt like a fresh one incl the exact resume it came from.
    // stay: the url already names it, as after a refresh
    async function openHistoryAttempt(id, { stay = false } = {}) {
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
                const restored = new File([fileRes.data], filename, { type: RESUME_EXT_MIME[ext] || "application/octet-stream" })
                // already on the server, so re-analysing it doesn't upload it again
                const done = { file: restored, status: "done", resumeId: res.data.resume_id, parsed: resultsData.parsed_resume }
                uploadRef.current = { file: restored, failed: false, promise: Promise.resolve(done) }
                setUpload(done)
                setFile(restored)
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
            if (!stay) {
                const coverLetterOnly = res.data.attempt_type === "cover_letter_only"
                navigate(attemptPath(res.data.id, coverLetterOnly ? "documents" : "review", coverLetterOnly ? "cover-letter" : ""))
            }
            setSidebarCollapsed(false)
            setExported(false)
            autoCollapsedRef.current = false
        } catch (err) {
            setError(getError(err))
            if (stay) navigate("/", { replace: true })
        } finally { restoringRef.current = false }
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
                toast("Cover letter generated from Job Fit")
                navigate(attemptPath(attemptId, "documents", "cover-letter"))
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
                ? `Tailored CV generated. ${flagged} flagged suggestion${flagged === 1 ? " was" : "s were"} left out, review ${flagged === 1 ? "it" : "them"} under Review`
                : "New attempt analysed and Tailored CV generated from Job Fit")
            navigate(attemptPath(landed.analysisId, "documents", "cv"))
        } catch (err) {
            toast(getError(err), "error")
        } finally {
            setJmBusy("")
        }
    }

    // the landing page's "try a sample": the bundled resume and job ad, on the
    // offline demo when it's switched on so it needs no key at all
    const sampleRef = useRef(false)
    async function trySample() {
        try {
            const [pdf, jd] = await Promise.all([
                fetch("/sample-resume.pdf").then(res => res.blob()),
                fetch("/sample-job.txt").then(res => res.text()),
            ])
            const sample = new File([pdf], "sample-resume.pdf", { type: "application/pdf" })
            const chosen = status.demo ? "demo" : provider
            setProvider(chosen)
            setJobDescription(jd)
            setFile(sample)
            navigate("/", { replace: true })
            await analyse(jd, { fileOverride: sample, providerOverride: chosen })
        } catch (err) {
            setError(getError(err))
        } finally {
            sampleRef.current = false
        }
    }

    const isCandidate = user?.role === "candidate"

    useEffect(() => {
        if (!isCandidate || route.screen !== "sample" || !statusLoaded || sampleRef.current) return
        sampleRef.current = true
        trySample()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isCandidate, route.screen, statusLoaded])

    // an attempt's url opens that attempt, after a refresh or from a link. not while
    // another one is opening, its url only changes once it has loaded
    const [opening, setOpening] = useState(null)
    useEffect(() => {
        if (!isCandidate || route.screen !== "attempt" || busy || restoringRef.current) return
        if (route.id === null) {
            // a streamed attempt that isn't in memory any more
            if (!result) navigate("/", { replace: true })
            return
        }
        if (attemptId === route.id || opening === route.id) return
        setOpening(route.id)
        openHistoryAttempt(route.id, { stay: true }).finally(() => setOpening(null))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isCandidate, route.screen, route.id, attemptId, busy])

    if (!user) return <Landing />

    // mentors land in their workspace
    if (!isCandidate) {
        return <>
            <ToastHost />
            <AppHeader user={user} onLogout={logout} />
            <main className="app-container"><MentorDashboard /></main>
        </>
    }

    const inAttempt = route.screen === "attempt" && !!result
    const gate = (icon, message, landOn) => <AnalysisRequiredGate icon={icon} busy={busy} message={message} onAnalyse={() => analyse(undefined, { landOn })} />

    function renderTab() {
        if (route.tab === "review") {
            return <>
                <SubNav attemptId={attemptId} tab="review" current={route.sub} />
                {route.sub === "sections"
                    ? <ExtractedSections result={result} />
                    : isCoverLetterOnlyAttempt
                        ? <><h2 className="view-title">Review Suggestions</h2>{gate(MessageSquareText, "This attempt only generated a Cover Letter - run a full analysis on the same resume to get rewrite suggestions.", { tab: "review" })}</>
                        : <RewriteReview result={result} file={file} decisions={decisions} setDecisions={setDecisions} analysisId={pending ? null : analysisId} pending={pending} />}
            </>
        }
        if (pending) return <div className="card muted">This fills in when the analysis finishes. Suggestions are already arriving under Review.</div>
        if (route.tab === "job-fit") {
            return <JobFit result={result} decisions={decisions} jobMatching={{
                provider, localEndpoint, jobMatch, setJobMatch,
                onReanalyse: jd => analyse(jd),
                onGenerateCV: jd => generateCVFromJobMatch(jd),
                onGenerateCoverLetter: jd => generateCoverLetterFromJobMatch(jd),
                analysing: busy, busyAction: jmBusy,
            }} />
        }
        if (route.tab === "documents") {
            return <>
                <SubNav attemptId={attemptId} tab="documents" current={route.sub} />
                {route.sub === "cover-letter"
                    ? <DocumentGenerator type="cover-letter" result={result} provider={provider} localEndpoint={localEndpoint} decisions={decisions} analysisId={analysisId} text={docs.cover_letter} setText={t => setDocs({ ...docs, cover_letter: t })} onExport={() => setExported(true)} fullName={fullName} company={jobMatch.company} onChangeJobDescription={refreshJobDescription} />
                    : isCoverLetterOnlyAttempt
                        ? <><h2 className="view-title">Generate Tailored CV</h2>{gate(FileEdit, "A Tailored CV is built from rewrite suggestions, which need a full resume analysis first.", { tab: "documents", sub: "cv" })}</>
                        : <DocumentGenerator type="cv" result={result} provider={provider} localEndpoint={localEndpoint} decisions={decisions} analysisId={analysisId} text={docs.cv} setText={t => setDocs({ ...docs, cv: t })} onExport={() => setExported(true)} fullName={fullName} />}
            </>
        }
        if (route.tab === "progress") {
            return <>
                {isCoverLetterOnlyAttempt
                    ? <><h2 className="view-title">Progress</h2>{gate(BarChart3, "Score trends, job fit and section-strength insights need a full resume analysis.", { tab: "progress" })}</>
                    : <Insights result={result} history={history} decisions={decisions} />}
                <AttemptHistory compact history={history} onOpenAttempt={openHistoryAttempt} unreadById={notifSummary.by_analysis_id} />
            </>
        }
        return <>
            <FeedbackInbox analysisId={attemptId} attemptType={result?.attempt_type} unreadByType={notifSummary.by_attempt_type} onDocumentAccepted={(documentType, text) => setDocs(d => ({ ...d, [documentType]: text }))} />
            <SessionJoin />
        </>
    }

    return <>
        <ToastHost />
        <AppHeader user={user} onLogout={logout}>
            {inAttempt && <TopNav attemptId={attemptId} badges={{ mentor: notifSummary.unread_total }} />}
        </AppHeader>
        <main className="app-container">
            {error && <p className="warning-strip" role="alert">{error}</p>}
            {progress && inAttempt && <AnalysisProgress progress={progress} />}

            {route.screen === "history" && <AttemptHistory history={history} onOpenAttempt={id => openHistoryAttempt(id)} unreadById={notifSummary.by_analysis_id} />}

            {inAttempt && <>
                <div className="attempt-bar">
                    <span className="attempt-bar-name">{file?.name || "Resume analysed"}</span>
                    <Link to="/" className="btn-ghost btn-small">Change resume, job or provider</Link>
                </div>
                <div className={`workspace ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
                    <ResultsSidebar result={result} history={history} collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />
                    <div className="workspace-main">
                        <div className="fade-in" key={`${route.tab}/${route.sub}`}>{renderTab()}</div>
                    </div>
                </div>
            </>}

            {route.screen === "attempt" && !result && <p className="muted opening-attempt" role="status">Opening the attempt…</p>}

            {(route.screen === "setup" || route.screen === "sample") && <>
                <PipelineStepper file={file} busy={busy} result={result} docs={docs} exported={exported} />
                {result && !busy && <p className="setup-back"><Link to={attemptPath(attemptId, "review")}><ArrowLeft size={14} aria-hidden="true" /> Back to the open attempt</Link></p>}
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
                    <Link className="btn-secondary model-bar-history" to="/history"><History size={13} aria-hidden="true" /> Past attempts<NotificationBadge count={notifSummary.unread_total} /></Link>
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
                <ResumeSetup file={file} setFile={setFile} jobDescription={jobDescription} setJobDescription={setJobDescription} onAnalyse={() => analyse()} onQuickCoverLetter={generateCoverLetterOnly} busy={busy || needsKey} quickBusy={quickBusy || needsKey} preview={<ParsePreview upload={upload} />} />
                {needsKey && <p className="warning-strip">Add a {providerMeta.label.replace(" (Own Key)", "")} API key above, or switch to Default (Free), before analysing.</p>}
                {progress && <AnalysisProgress progress={progress} />}
                {!result && !busy && <details className="card"><summary>Mentor Feedback &amp; Review Sessions<NotificationBadge count={notifSummary.unread_total} /></summary><div className="prelim-panels"><SessionJoin /><FeedbackInbox showTitle={false} unreadByType={notifSummary.by_attempt_type} onDocumentAccepted={(documentType, text) => setDocs(d => ({ ...d, [documentType]: text }))} /></div></details>}
            </>}
        </main>
    </>
}

export default App
