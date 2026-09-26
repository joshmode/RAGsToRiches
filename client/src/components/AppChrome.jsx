import { useState } from "react"
import {
    MessageSquareText, SearchCheck, FileEdit, Mail, Users, BarChart3, Briefcase, FileText, History,
    ChevronDown, UploadCloud, Sparkles, ClipboardCheck, FileOutput, Download, Check, Loader2, LogIn, LogOut,
} from "lucide-react"
import { NotificationBadge } from "./NotificationBadge"

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

const PIPELINE_STEPS = [
    { key: "upload", label: "Upload Resume", icon: UploadCloud },
    { key: "analyse", label: "AI Analysis", icon: Sparkles },
    { key: "review", label: "Review Suggestions", icon: ClipboardCheck },
    { key: "generate", label: "Generate Tailored Resume", icon: FileOutput },
    { key: "export", label: "Export", icon: Download },
]

export function Hero() {
    return <section className="hero-wrap">
        <div className="hero-eyebrow">Resume intelligence, reimagined</div>
        <h1 className="hero-title"><span className="title-prefix">RagsToRiches:</span><br /><span className="accent">Smarter resumes, smarter opportunities.</span></h1>
        <p className="hero-sub">Review rewrite suggestions against the uploaded resume, apply the changes you trust, then generate a CV from those decisions with or without a job description.</p>
    </section>
}

// one sign-in/out control
export function AuthBar({ user, onLogout }) {
    return <div className="auth-bar">
        {user ? <>
            <span className="auth-bar-status">{user.is_guest ? "Browsing as " : "Signed in as "}<b>{user.display_name}</b></span>
            <button className="btn-ghost btn-small" onClick={onLogout}>{user.is_guest ? <><LogIn size={13} /> Sign In</> : <><LogOut size={13} /> Sign Out</>}</button>
        </> : <span className="auth-bar-status">Sign In</span>}
    </div>
}

// fixed, never auto-hides 
export function TopNav({ view, setView, badges = {} }) {
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

export function PipelineStepper({ file, busy, result, docs, exported }) {
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
