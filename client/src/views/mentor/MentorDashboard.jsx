import { useEffect, useState } from "react"
import { Ban } from "lucide-react"
import api from "../../api/client"
import { getError } from "../../lib/errors"
import { getScoreCfg } from "../../lib/score"
import { useNotifSummary } from "../../hooks/useNotifSummary"
import { NotificationBadge } from "../../components/NotificationBadge"
import { CandidateDetail } from "./CandidateDetail"

export function MentorDashboard() {
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
