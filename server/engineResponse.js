// The engine normally answers in JSON. A reverse proxy or an engine crash can
// answer with plain text instead, and blindly calling json() then turns the real
// upstream failure (often a 413) into a generic 500 from this API.
export async function engineJson(resp) {
    try {
        // Read once. Response.json() consumes the body even when parsing fails,
        // so falling back to text() afterwards cannot recover the real message.
        const text = await resp.text()
        if (!text.trim()) return {}
        try {
            return JSON.parse(text)
        } catch {
            return { error: text.trim().slice(0, 500) }
        }
    } catch {
        return {}
    }
}

export function engineError(detail, fallback) {
    return String(detail?.error || detail?.message || fallback)
}
