import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { IdCard, Mail, PanelLeftClose, PanelLeftOpen, X } from "lucide-react"
import { getScoreCfg } from "../../lib/score"
import { ScoreCard } from "../../components/ScoreCard"

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

export function ResultsSidebar({ result, history, collapsed, onToggleCollapse }) {
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
                <button className="sidebar-toggle" onClick={onToggleCollapse} title="Expand sidebar" aria-label="Expand sidebar"><PanelLeftOpen size={18} /></button>
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
                    <button className="sidebar-toggle" onClick={onToggleCollapse} title="Collapse sidebar" aria-label="Collapse sidebar"><PanelLeftClose size={16} /></button>
                </div>
                <ScoreCard scoreData={result.score} history={history.filter(h => h.attempt_type !== "cover_letter_only")} attemptType={result.attempt_type} pending={!!result.partial} />
                <div className="sidebar-scroll">
                    <div className="card"><span className="section-label">Parser Status</span>{["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS"].map(name => <p key={name} className={sections[name] ? "ok-text" : "error-text"}>{sections[name] ? "✓" : "✗"} {name[0] + name.slice(1).toLowerCase()}</p>)}</div>
                    {hasContact && <button className="btn-ghost sidebar-metadata-btn" onClick={() => setShowMetadata(true)}><IdCard size={14} /> Resume Metadata</button>}
                </div>
            </div>
        )}
        </aside>
        {showMetadata && <ResumeMetadataModal contact={contact} onClose={() => setShowMetadata(false)} />}
    </>
}
