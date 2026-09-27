import { useState } from "react"
import { useAuth } from "../context/AuthContext"
import { getError } from "../lib/errors"

export function AuthCard({ id }) {
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
        <section className="auth-card" id={id}>
            <h2>Sign in to RAGsToRiches</h2>
            <p className="auth-sub">An account keeps your attempts, documents and mentor feedback.</p>
            <div className="auth-tabs" role="tablist" aria-label="Sign in or register">
                <button type="button" role="tab" aria-selected={tab === "login"} className={`auth-tab ${tab === "login" ? "active" : ""}`} onClick={() => { setTab("login"); setError("") }}>Sign In</button>
                <button type="button" role="tab" aria-selected={tab === "register"} className={`auth-tab ${tab === "register" ? "active" : ""}`} onClick={() => { setTab("register"); setError("") }}>Register</button>
            </div>
            <form onSubmit={submit}>
                {tab === "register" && <>
                    <Field label="Display Name" value={form.display_name} onChange={v => update("display_name", v)} required autoComplete="name" />
                    <Field label="Email (optional)" type="email" value={form.email} onChange={v => update("email", v)} autoComplete="email" />
                </>}
                <Field label="Username" value={form.username} onChange={v => update("username", v)} required autoComplete="username" />
                <Field label="Password" type="password" value={form.password} onChange={v => update("password", v)} required autoComplete={tab === "login" ? "current-password" : "new-password"} />
                {tab === "register" && <>
                    <Field label="Confirm Password" type="password" value={form.confirm} onChange={v => update("confirm", v)} required autoComplete="new-password" />
                    <label className="form-group">I am a...
                        <select className="input-field" value={form.role} onChange={e => update("role", e.target.value)}>
                            <option value="candidate">Candidate</option>
                            <option value="mentor">Mentor</option>
                        </select>
                    </label>
                </>}
                {error && <p className="error-msg" role="alert">{error}</p>}
                <button className="btn-primary full-width auth-submit-btn" disabled={busy}>{busy ? "Please wait..." : tab === "login" ? "Sign In" : "Create Account"}</button>
            </form>
            <div className="auth-guest-row">
                <button type="button" className="auth-guest-link" disabled={busy} onClick={guestContinue}>Continue without an account</button>
                <p className="muted auth-guest-note">Guest sessions aren't tied to an account — you won't be able to sign back in to this session, and any uploaded resumes and analysis are automatically deleted from our servers within 24 hours.</p>
            </div>
        </section>
    )
}

function Field({ label, type = "text", value, onChange, required, autoComplete }) {
    return <label className="form-group">{label}<input className="input-field" type={type} value={value} onChange={e => onChange(e.target.value)} required={required} autoComplete={autoComplete} /></label>
}
