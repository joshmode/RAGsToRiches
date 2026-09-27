// the theme picked in the account menu: "light", "dark", or "" to follow the system.
// index.css reads it from data-theme on <html>
const KEY = "rtr_theme"

export const THEMES = [
    { key: "", label: "System" },
    { key: "light", label: "Light" },
    { key: "dark", label: "Dark" },
]

export function storedTheme() {
    try {
        const theme = localStorage.getItem(KEY) || ""
        return THEMES.some(t => t.key === theme) ? theme : ""
    } catch {
        return ""
    }
}

export function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    try {
        if (theme) localStorage.setItem(KEY, theme)
        else localStorage.removeItem(KEY)
    } catch { /* only a preference */ }
}

export function nextTheme(theme) {
    const at = THEMES.findIndex(t => t.key === theme)
    return THEMES[(at + 1) % THEMES.length].key
}
