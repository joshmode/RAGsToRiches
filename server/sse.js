// Split accumulated SSE text into complete events plus the partial frame left over.
// The same parsing as client/src/api/stream.js: a chunk can end mid-frame, so the
// remainder is kept for the next one.
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
            // an unparseable frame is dropped, the terminal done/error event is what matters
        }
    }

    return { events, rest }
}
