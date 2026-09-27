import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { BadgeCheck, Gauge, Tags } from "lucide-react"
import { useAuth } from "../context/AuthContext"
import { getError } from "../lib/errors"
import { Brand } from "../components/AppChrome"
import { AuthCard } from "./AuthPage"

const POINTS = [
    {
        icon: Gauge,
        title: "A score for your resume, not for the AI",
        body: "The rubric reads your own bullets: figures, action verbs and structure. Accepting a rewrite can't inflate it.",
    },
    {
        icon: BadgeCheck,
        title: "Every rewrite checked for invented claims",
        body: "A figure you never gave, a bigger role or a borrowed skill is flagged, and flagged rewrites stay out of bulk accepts.",
    },
    {
        icon: Tags,
        title: "Job keywords only where you've earned them",
        body: "A keyword goes into a bullet only when the bullet already implies it, like Python for a Flask service.",
    },
]

// what someone signed out sees: what this is, a way to try it, and the sign-in
export function Landing() {
    const { continueAsGuest } = useAuth()
    const navigate = useNavigate()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")

    // a guest session with the bundled sample, analysed straight away
    async function trySample() {
        setBusy(true)
        setError("")
        try {
            navigate("/sample")
            await continueAsGuest()
        } catch (err) {
            navigate("/")
            setError(getError(err))
            setBusy(false)
        }
    }

    return <div className="landing">
        <header className="app-header">
            <Brand />
            <a className="btn-ghost btn-small landing-signin" href="#sign-in">Sign in</a>
        </header>
        <main className="app-container">
            <section className="landing-hero">
                <p className="landing-eyebrow">Resume feedback you can check</p>
                <h1 className="landing-title">Stronger resume bullets, <span className="accent">with nothing invented.</span></h1>
                <p className="landing-sub">
                    RAGsToRiches suggests a stronger version of each bullet, grounded in writing guides it retrieves for
                    that bullet. It scores your resume on a fixed rubric, checks every rewrite for claims your original
                    doesn't make, and leaves the decision to you.
                </p>
                <div className="landing-actions">
                    <button type="button" className="btn-primary" onClick={trySample} disabled={busy}>{busy ? <><span className="spinner" /> Starting…</> : "Try a sample resume"}</button>
                    <a className="btn-secondary" href="#sign-in">Sign in or register</a>
                </div>
                <p className="muted landing-note">The sample is a fictional resume and job ad, analysed in a guest session that's deleted within a day.</p>
                {error && <p className="error-msg" role="alert">{error}</p>}
            </section>
            <section className="landing-points" aria-label="What it does">
                {POINTS.map(({ icon: Icon, title, body }) => <div className="card landing-point" key={title}>
                    <Icon size={20} aria-hidden="true" />
                    <h2>{title}</h2>
                    <p className="muted">{body}</p>
                </div>)}
            </section>
            <AuthCard id="sign-in" />
        </main>
    </div>
}
