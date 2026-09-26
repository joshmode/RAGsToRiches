import { useEffect, useState } from "react"
import api from "../api/client"

const NOTIFICATION_SUMMARY_DEFAULT = { unread_total: 0, by_attempt_type: {}, by_analysis_id: {}, by_candidate_id: {}, by_candidate_and_type: {} }

// every badge off one endpoint no websocket 
export function useNotifSummary(enabled) {
    const [summary, setSummary] = useState(NOTIFICATION_SUMMARY_DEFAULT)
    function refresh() {
        if (!enabled) return
        api.get("/notifications/summary").then(res => setSummary(res.data)).catch(() => {})
    }
    useEffect(() => {
        if (!enabled) { setSummary(NOTIFICATION_SUMMARY_DEFAULT); return undefined }
        refresh()
        const id = setInterval(refresh, 30000)
        return () => clearInterval(id)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled])
    return [summary, refresh]
}
