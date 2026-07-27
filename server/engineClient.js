import fetch from "node-fetch"

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1500
const MAX_DELAY_MS = 20000

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// retries a whole engine call
export async function fetchEngineWithRetry(url, options, attempt = 0) {
    const res = await fetch(url, options)

    if (res.status === 429 && attempt < MAX_RETRIES) {
        let retryAfterSec = 0
        try {
            retryAfterSec = Number((await res.clone().json()).retry_after) || 0
        } catch {
            // no json body to read retry_after out of
        }
        const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
        const jitter = Math.random() * 500
        await sleep(retryAfterSec > 0 ? retryAfterSec * 1000 + jitter : backoff + jitter)
        return fetchEngine(url, options, attempt + 1)
    }

    return res
}
