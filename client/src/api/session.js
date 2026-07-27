// real accounts in localStorage, guests in sessionStorage 
const TOKEN_KEY = "rtr_token"
const USER_KEY = "rtr_user"

export function getToken() {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY)
}

export function getUserRaw() {
    return localStorage.getItem(USER_KEY) || sessionStorage.getItem(USER_KEY)
}

export function setSession(token, user, persistent) {
    const keep = persistent ? localStorage : sessionStorage
    const drop = persistent ? sessionStorage : localStorage
    drop.removeItem(TOKEN_KEY)
    drop.removeItem(USER_KEY)
    keep.setItem(TOKEN_KEY, token)
    keep.setItem(USER_KEY, JSON.stringify(user))
}

export function clearSession() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
}
