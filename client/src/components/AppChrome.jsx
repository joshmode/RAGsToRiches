import { useEffect, useRef, useState } from "react"
import { Link, NavLink } from "react-router-dom"
import {
    MessageSquareText, FileEdit, Users, BarChart3, Briefcase, ChevronDown, UploadCloud, Sparkles, ClipboardCheck,
    FileOutput, Download, Check, Loader2, LogIn, LogOut, History, Trash2, UserRound,
} from "lucide-react"
import { NotificationBadge } from "./NotificationBadge"
import { TABS, attemptPath } from "../lib/routes"

const TAB_ICONS = { review: MessageSquareText, "job-fit": Briefcase, documents: FileEdit, progress: BarChart3, mentor: Users }

const PIPELINE_STEPS = [
    { key: "upload", label: "Upload Resume", icon: UploadCloud },
    { key: "analyse", label: "AI Analysis", icon: Sparkles },
    { key: "review", label: "Review Suggestions", icon: ClipboardCheck },
    { key: "generate", label: "Generate Tailored Resume", icon: FileOutput },
    { key: "export", label: "Export", icon: Download },
]

export function Brand() {
    return <Link to="/" className="brand" aria-label="RAGsToRiches, start page">
        <img src="/favicon.svg" alt="" width={26} height={26} />
        <span>RAGsToRiches</span>
    </Link>
}

// the one place to sign out, find past attempts or delete the account
function AccountMenu({ user, onLogout, onDeleteAccount }) {
    const [open, setOpen] = useState(false)
    const wrapRef = useRef(null)

    useEffect(() => {
        if (!open) return undefined
        function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
        function onKey(e) { if (e.key === "Escape") setOpen(false) }
        document.addEventListener("mousedown", onDocClick)
        document.addEventListener("keydown", onKey)
        return () => {
            document.removeEventListener("mousedown", onDocClick)
            document.removeEventListener("keydown", onKey)
        }
    }, [open])

    return <div className="account-menu" ref={wrapRef}>
        <button type="button" className="account-toggle" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            <UserRound size={15} aria-hidden="true" />
            <span className="account-name">{user.display_name}</span>
            {user.is_guest && !/^guest\b/i.test(user.display_name || "") && <span className="guest-tag">Guest</span>}
            <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open && <div className="account-dropdown" role="menu">
            {user.role === "candidate" && <Link role="menuitem" to="/history" onClick={() => setOpen(false)}><History size={14} aria-hidden="true" /> Past attempts</Link>}
            {!user.is_guest && onDeleteAccount && <button type="button" role="menuitem" onClick={() => { setOpen(false); onDeleteAccount() }}>
                <Trash2 size={14} aria-hidden="true" /> Delete account
            </button>}
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onLogout() }}>
                {user.is_guest ? <><LogIn size={14} aria-hidden="true" /> Sign in or register</> : <><LogOut size={14} aria-hidden="true" /> Sign out</>}
            </button>
        </div>}
    </div>
}

// one slim bar on every screen, with the attempt's tabs in it when one is open
export function AppHeader({ user, onLogout, onDeleteAccount, children }) {
    return <header className="app-header">
        <Brand />
        {children}
        {user && <AccountMenu user={user} onLogout={onLogout} onDeleteAccount={onDeleteAccount} />}
    </header>
}

export function TopNav({ attemptId, badges = {} }) {
    return <nav className="top-nav" aria-label="Attempt">
        {TABS.map(({ key, label }) => {
            const Icon = TAB_ICONS[key]
            return <NavLink key={key} to={attemptPath(attemptId, key)} className={({ isActive }) => `nav-pill ${isActive ? "active" : ""}`}>
                <Icon size={14} aria-hidden="true" /><span>{label}</span><NotificationBadge count={badges[key]} />
            </NavLink>
        })}
    </nav>
}

// the views inside a tab, e.g. the cv and the cover letter under documents
export function SubNav({ attemptId, tab, current }) {
    const { label, subs = [] } = TABS.find(t => t.key === tab) || {}
    return <nav className="sub-nav" aria-label={`${label} views`}>
        {subs.map(sub => <Link
            key={sub.key} to={attemptPath(attemptId, tab, sub.key)}
            className={sub.key === current ? "active" : ""} aria-current={sub.key === current ? "page" : undefined}
        >{sub.label}</Link>)}
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
