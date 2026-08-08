import { getToken } from "./session.js"

/**
 * Split accumulated SSE text into complete events plus whatever is left over.
 *
 * A network chunk can end mid-frame, so the trailing partial frame must be kept
 * and prepended to the next chunk. Returning it explicitly keeps this a pure
 * function, which is why the parsing lives here rather than inline in the reader.
 *
 * @param {string} buffer accumulated text, may end mid-frame
 * @returns {{events: object[], rest: string}}
 */
export function parseSSEBuffer(buffer) {
    const events = []
    let rest = buffer

    while (true) {
        const boundary = rest.indexOf("\n\n")
        if (boundary === -1) break

        const frame = rest.slice(0, boundary)
        rest = rest.slice(boundary + 2)

        const data = frame
            .split("\n")
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart())
            .join("\n")

        if (!data) continue
        try {
            events.push(JSON.parse(data))
        } catch {
            // A frame we cannot parse is dropped rather than killing the stream:
            // the terminal done/error event is what actually matters.
        }
    }

    return { events, rest }
}

/**
 * Run an analysis and receive progress events as they happen.
 *
 * EventSource only speaks GET and cannot send an Authorization header, so this
 * uses fetch and reads the body itself.
 *
 * @param {object} payload same shape as the /analysis/run body
 * @param {(event: object) => void} onEvent called per progress event
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<object>} the final result, from the terminal `done` event
 */
export async function streamAnalysis(payload, onEvent, options = {}) {
    const token = getToken()
    const response = await fetch("/api/analysis/stream", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: options.signal,
    })

    if (!response.ok) {
        let message = "The analysis could not be started."
        try {
            message = (await response.json()).error || message
        } catch {
            // non-JSON error body; keep the default
        }
        throw new Error(message)
    }
    if (!response.body) {
        throw new Error("Streaming is not supported in this browser.")
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let result = null

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const { events, rest } = parseSSEBuffer(buffer)
            buffer = rest

            for (const event of events) {
                onEvent?.(event)
                if (event.stage === "done") result = event.result
                if (event.stage === "error") throw new Error(event.error || "Analysis failed.")
            }
        }
    } finally {
        reader.cancel().catch(() => {})
    }

    if (!result) {
        throw new Error("The analysis stream ended before returning a result.")
    }
    return result
}
