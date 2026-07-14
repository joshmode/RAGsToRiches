
const TOKEN_KEY = "rtr_token"
const USER_KEY = "rtr_user"

export function getToken() {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY)
}

export function getStoredUserRaw() {
    return localStorage.getItem(USER_KEY) || sessionStorage.getItem(USER_KEY)
}

export function setSession(token, user, persistent) {
    const store = persistent ? localStorage : sessionStorage
    const other = persistent ? sessionStorage : localStorage
    other.removeItem(TOKEN_KEY)
    other.removeItem(USER_KEY)
    store.setItem(TOKEN_KEY, token)
    store.setItem(USER_KEY, JSON.stringify(user))
}

export function clearSession() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
}
