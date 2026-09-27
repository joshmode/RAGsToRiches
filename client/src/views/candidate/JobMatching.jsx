import { useEffect, useRef, useState } from "react"
import { Building2, FileEdit, Mail, RotateCw } from "lucide-react"
import api from "../../api/client"
import { getError } from "../../lib/errors"
import { KeywordGap } from "./KeywordGap"

export function JobMatching({ result, provider, localEndpoint, jobMatch, setJobMatch, onReanalyse, onGenerateCV, onGenerateCoverLetter, analysing, busyAction }) {
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

    return <section className="job-matching-page">
        <h3 className="doc-subhead">Check another job</h3>
        <p className="muted">Paste a job ad's link to see how this resume covers it, then re-analyse or write documents for that job.</p>
        <div className="scrape-row">
            <input className="input-field" aria-label="Job ad link" value={url} onChange={e => patch({ url: e.target.value })} placeholder="Enter Job Description URL" />
            <button className="job-match-action" onClick={scrape} disabled={scrapeBusy}>{scrapeBusy ? <><span className="spinner" />Scraping…</> : "Scrape"}</button>
        </div>
        {scraped && <textarea className="input-field document-editor" aria-label="Scraped job description" value={scraped} onChange={e => patch({ scraped: e.target.value })} />}
        {error && <p className="error-msg">{error}</p>}

        <button className="job-match-action job-match-compare" onClick={compare} disabled={compareBusy || (!scraped && !result.job_description)}>
            {compareBusy ? <><span className="spinner" />Comparing…</> : "Compare Resume to Job"}
        </button>

        {comparison && <div className="job-match-results">
            <div className="card job-match-score-card">
                <span className="section-label">Fit for this job</span>
                <p className="metric-value">{comparison.match_pct != null ? `${comparison.match_pct}%` : "—"}</p>
                <p className="muted">Share of the job description's keywords your resume already mentions.</p>
                <p><b>Strong matches:</b> {(comparison.strong_matches || []).join(", ") || "None"}</p>
                <p><b>Missing skills:</b> {(comparison.missing_keywords || []).join(", ") || "None"}</p>
                <p><b>Tailoring tips:</b> {(comparison.tailoring_tips || []).join(" · ") || "None"}</p>
                {company && <p className="job-match-company"><Building2 size={13} /> {company}</p>}
            </div>

            <KeywordGap result={comparison} />

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
            <input className="input-field" aria-label="LinkedIn profile link" value={linkedinUrl} onChange={e => patch({ linkedinUrl: e.target.value })} placeholder="LinkedIn Profile URL (public preview only)" />
            <button className="btn-secondary" onClick={scrapeLinkedIn} disabled={linkedinBusy}>{linkedinBusy ? <><span className="spinner" />Loading…</> : "Preview Profile"}</button>
        </div>
        {liProfile && (profileError ? <p className="warning-strip">{profileError}</p> : <div className="card">{liProfile.name && <p><b>{liProfile.name}</b></p>}{liProfile.headline && <p>{liProfile.headline}</p>}{liProfile.note && <p className="muted">{liProfile.note}</p>}</div>)}
    </section>
}
