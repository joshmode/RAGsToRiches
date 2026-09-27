// The session is an httpOnly cookie the browser sends by itself, so nothing here
// stores a token. This only lets a request that finds the session gone tell the app.
let onEnded = () => {}

export function whenSessionEnds(handler) {
    onEnded = handler
    return () => { if (onEnded === handler) onEnded = () => {} }
}

export function sessionEnded() {
    onEnded()
}

// older versions kept the token in storage, where any script on the page could read it
export function forgetStoredTokens() {
    try {
        for (const store of [localStorage, sessionStorage]) {
            store.removeItem("rtr_token")
            store.removeItem("rtr_user")
        }
    } catch { /* storage blocked, nothing to forget */ }
}
