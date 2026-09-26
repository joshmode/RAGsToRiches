import { Sparkles } from "lucide-react"

// no rewrites/score/keywords on these so show something
export function AnalysisRequiredGate({ icon: Icon, message, onAnalyse, busy }) {
    return <div className="card analysis-gate">
        <Icon size={26} />
        <p>{message}</p>
        <button className="btn-primary" disabled={busy} onClick={onAnalyse}>
            {busy ? <><span className="spinner" /> Analysing…</> : <><Sparkles size={16} /> Analyse My Resume</>}
        </button>
    </div>
}
