import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Trash2, X } from "lucide-react"
import api from "../api/client"
import { getError } from "../lib/errors"

// everything the account owns goes with it, so an account asks for its password. a
// guest has none: their session and its data go now instead of within a day
export function DeleteAccount({ user, onClose, onDeleted }) {
    const [password, setPassword] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const firstRef = useRef(null)
    const guest = !!user.is_guest

    useEffect(() => {
        firstRef.current?.focus()
        function onKey(e) { if (e.key === "Escape") onClose() }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [onClose])

    async function confirm(e) {
        e.preventDefault()
        setBusy(true)
        setError("")
        try {
            await api.delete("/auth/account", { data: guest ? {} : { password } })
            onDeleted()
        } catch (err) {
            setError(getError(err))
            setBusy(false)
        }
    }

    return createPortal(<div className="modal-overlay" onClick={onClose}>
        <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="delete-account-title" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
                <h3 className="modal-title" id="delete-account-title">{guest ? "Delete this guest session" : "Delete your account"}</h3>
                <button type="button" className="btn-ghost modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
            </div>
            <form onSubmit={confirm}>
                <p className="delete-account-text">{guest
                    ? "This deletes the resumes, analyses and documents in this session now, instead of within a day."
                    : "This permanently deletes your account and every resume, analysis, document and piece of mentor feedback in it. It can't be undone."}</p>
                {!guest && <label className="form-group">Your password
                    <input ref={firstRef} className="input-field" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
                </label>}
                {error && <p className="error-msg" role="alert">{error}</p>}
                <div className="modal-actions">
                    <button type="button" className="btn-ghost" onClick={onClose} ref={guest ? firstRef : undefined}>Cancel</button>
                    <button type="submit" className="btn-destructive" disabled={busy || (!guest && !password)}>
                        <Trash2 size={14} aria-hidden="true" /> {busy ? "Deleting…" : guest ? "Delete session" : "Delete my account"}
                    </button>
                </div>
            </form>
        </div>
    </div>, document.body)
}
