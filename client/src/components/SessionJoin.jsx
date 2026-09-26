import { useState } from "react"
import api from "../api/client"
import { getError } from "../lib/errors"

export function SessionJoin() {
    const [code, setCode] = useState("")
    const [message, setMessage] = useState("")
    async function join() {
        try {
            await api.post("/mentor/session/join", { code })
            setMessage("Joined review session.")
        } catch (err) { setMessage(getError(err)) }
    }
    return <div className="card">
        <span className="section-label">Collaborative Review</span>
        <p className="session-join-hint muted">Ask your mentor for their session code to enable collaborative review of your resume.</p>
        <input className="input-field" value={code} onChange={e => setCode(e.target.value)} placeholder="Enter mentor session code" />
        <button className="btn-secondary btn-block-gap" onClick={join}>Join Session</button>
        {message && <p className="muted">{message}</p>}
    </div>
}
