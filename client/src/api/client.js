import axios from "axios"
import { sessionEnded } from "./session"

// same origin, so the browser sends the session cookie with every request
const api = axios.create({
    baseURL: "/api",
    timeout: 300000,
})

const MAX_429_RETRIES = 4
const BASE_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 15000

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

api.interceptors.response.use(
    (res) => res,
    async (err) => {
        // the session is gone. a wrong password on sign-in is a 401 too, and isn't
        if (err.response?.status === 401 && !String(err.config?.url || "").startsWith("/auth/")) {
            sessionEnded()
            return Promise.reject(err)
        }

        if (err.response?.status === 429) {
            const config = err.config || {}
            const n = config.__retryCount || 0
            if (n < MAX_429_RETRIES) {
                config.__retryCount = n + 1
                const sec = Number(err.response.data?.retry_after) || 0
                const backoff = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** n)
                await sleep((sec > 0 ? sec * 1000 : backoff) + Math.random() * 400)
                return api(config)
            }
        }

        return Promise.reject(err)
    }
)

export default api
