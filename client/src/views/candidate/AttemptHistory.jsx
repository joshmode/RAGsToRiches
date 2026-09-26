import { useMemo, useState } from "react"
import { Building2 } from "lucide-react"
import { NotificationBadge } from "../../components/NotificationBadge"
import { numberClAtts } from "../../lib/attempts"
import { formatDateTime } from "../../lib/format"

// either workflow each with its own toggle and numbering 
export function AttemptHistory({ history, onOpenAttempt, unreadById = {} }) {
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
