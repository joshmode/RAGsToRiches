import crypto from "crypto"
import { getDb } from "./db.js"

// per-user keys decrypted fresh per request from their own row
const ALGO = "aes-256-gcm"

const KEY_ENCRYPTION_SECRET = process.env.KEY_ENCRYPTION_SECRET ||
    (process.env.NODE_ENV === "production" ? "" : "ragstoriches_dev_key_encryption_secret")

if (!KEY_ENCRYPTION_SECRET) {
    throw new Error("KEY_ENCRYPTION_SECRET is required in production to store user API keys.")
}

// hash down to 32b for sha 256
const MASTER_KEY = crypto.createHash("sha256").update(KEY_ENCRYPTION_SECRET).digest()

export const BYOK_PROVIDERS = new Set(["gemini", "claude", "chatgpt"])

// every provider the ui can ask for
export const PROVIDER_CHOICES = new Set(["default", "gemini", "claude", "chatgpt", "local", "demo"])

// recorded answers, no key and no network. on unless a deployment turns it off
export function demoAllowed() {
    return process.env.ALLOW_DEMO_PROVIDER !== "false"
}

function encrypt(plain) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(ALGO, MASTER_KEY, iv)
    const buf = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
    return {
        encryptedKey: buf.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
    }
}

function decrypt({ encryptedKey, iv, authTag }) {
    const decipher = crypto.createDecipheriv(ALGO, MASTER_KEY, Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(authTag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(encryptedKey, "base64")), decipher.final()]).toString("utf8")
}

export function saveKey(userId, provider, key) {
    if (!BYOK_PROVIDERS.has(provider)) throw new Error("Unsupported provider for personal API keys.")
    const { encryptedKey, iv, authTag } = encrypt(key)
    getDb().prepare(`
        INSERT INTO user_api_keys (user_id, provider, encrypted_key, iv, auth_tag, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(user_id, provider) DO UPDATE SET
            encrypted_key = excluded.encrypted_key,
            iv = excluded.iv,
            auth_tag = excluded.auth_tag,
            updated_at = datetime('now')
    `).run(userId, provider, encryptedKey, iv, authTag)
}

export function deleteKey(userId, provider) {
    getDb().prepare("DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?").run(userId, provider)
}

export function hasKey(userId, provider) {
    return !!getDb().prepare("SELECT 1 FROM user_api_keys WHERE user_id = ? AND provider = ?").get(userId, provider)
}

function getKey(userId, provider) {
    const row = getDb().prepare(
        "SELECT encrypted_key, iv, auth_tag FROM user_api_keys WHERE user_id = ? AND provider = ?"
    ).get(userId, provider)
    if (!row) return null
    try {
        return decrypt({ encryptedKey: row.encrypted_key, iv: row.iv, authTag: row.auth_tag })
    } catch {
        // rotated secret or a corrupt row
        throw new ProviderError(
            `Your saved ${provider} API key could not be read and may be out of date. Please remove it and add it again.`
        )
    }
}

class ProviderError extends Error {
    constructor(message, status = 400) {
        super(message)
        this.status = status
    }
}

// the free tier runs on openrouter unless DEFAULT_PROVIDER=groq. a fast
// non-reasoning model there is worth benchmarking against the openrouter default
export function pooledProvider() {
    return process.env.DEFAULT_PROVIDER === "groq" ? "groq" : "openrouter"
}

// ui provider choice what the engine needs incl the user's own byok key
export function resolveProvider(userId, choice) {
    if (choice === "default") {
        // DEMO_MODE runs the whole free tier offline, for a keyless local run
        if (process.env.DEMO_MODE === "true") return { engineProvider: "replay", apiKey: "" }
        return { engineProvider: pooledProvider(), apiKey: "" } // pooled key
    }
    if (choice === "demo") {
        if (!demoAllowed()) throw new ProviderError("The offline demo is turned off for this deployment.", 403)
        return { engineProvider: "replay", apiKey: "" }
    }
    if (choice === "local") {
        return { engineProvider: "local", apiKey: "" }
    }
    if (!BYOK_PROVIDERS.has(choice)) {
        throw new ProviderError("Unknown provider.")
    }
    const apiKey = getKey(userId, choice)
    if (!apiKey) {
        throw new ProviderError(
            `No ${choice} API key saved for your account. Add one below, or choose Default (Free).`
        )
    }
    return { engineProvider: choice, apiKey }
}

export { ProviderError }
