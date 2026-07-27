import rateLimit from "express-rate-limit"

// reports retry_after both
function rateLimitHandler(message) {
    return (req, res) => {
        const ms = req.rateLimit?.resetTime ? req.rateLimit.resetTime.getTime() - Date.now() : 30000
        const sec = Math.max(1, Math.ceil(ms / 1000))
        res.setHeader("Retry-After", String(sec))
        res.status(429).json({ error: message, retry_after: sec })
    }
}

// floor against abuse
export const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler("Too many requests. Please slow down and try again shortly."),
})

// polling/highlighting fire constantly
export const pollLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 90,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ? `user:${req.user.id}` : req.ip,
    handler: rateLimitHandler("Refreshing too frequently. Please wait a moment."),
})

// login/register are brute-force targets for cyber attack
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: rateLimitHandler("Too many authentication attempts. Please try again later."),
})

// guest session creation has no credentials 
export const guestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler("Too many guest sessions started from this connection. Please wait a while, or create an account instead."),
})

// burns api budget not just cpu
export const llmLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ? `user:${req.user.id}` : req.ip,
    handler: rateLimitHandler("Too many analysis requests. Please wait a few minutes before trying again."),
})
