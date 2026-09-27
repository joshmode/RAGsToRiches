import { createContext, useContext, useEffect, useState } from "react"
import api from "../api/client"
import { forgetStoredTokens, whenSessionEnds } from "../api/session"

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
    // undefined until the server says whose cookie this is, if anyone's
    const [user, setUser] = useState(undefined)

    useEffect(() => {
        forgetStoredTokens()
        api.get("/auth/me").then(res => setUser(res.data.user || null)).catch(() => setUser(null))
        // a request that finds the session gone (expired, or the account deleted) signs out here
        return whenSessionEnds(() => setUser(null))
    }, [])

    async function login(username, password) {
        const res = await api.post("/auth/login", { username, password })
        setUser(res.data.user)
        return res.data.user
    }

    async function register(username, password, display_name, role, email) {
        const res = await api.post("/auth/register", { username, password, display_name, role, email })
        setUser(res.data.user)
        return res.data.user
    }

    // a session cookie, so it ends with the browser
    async function continueAsGuest() {
        const res = await api.post("/auth/guest")
        setUser(res.data.user)
        return res.data.user
    }

    async function logout() {
        try { await api.post("/auth/logout") } catch { /* the cookie goes with the account anyway */ }
        setUser(null)
    }

    return (
        <AuthContext.Provider value={{ user: user ?? null, login, register, continueAsGuest, logout, loading: user === undefined }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    return useContext(AuthContext)
}
