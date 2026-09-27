import { useEffect, useState } from "react"
import { CheckCircle2, XCircle } from "lucide-react"

// module-level pub/sub so anything can fire a toast
const toastListeners = new Set()

export function toast(message, kind = "success") {
    const entry = { id: `${Date.now()}_${Math.random()}`, message, kind }
    toastListeners.forEach(fn => fn(entry))
}

export function ToastHost() {
    const [toasts, setToasts] = useState([])
    useEffect(() => {
        function add(entry) {
            setToasts(prev => [...prev, entry])
            setTimeout(() => setToasts(prev => prev.filter(t => t.id !== entry.id)), 3200)
        }
        toastListeners.add(add)
        return () => toastListeners.delete(add)
    }, [])
    // always there, so a screen reader is already listening when a toast lands
    return <div className="toast-host" role="status" aria-live="polite">{toasts.map(t => (
        <div className={`toast toast-${t.kind}`} key={t.id}>
            {t.kind === "error" ? <XCircle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            {t.message}
        </div>
    ))}</div>
}
