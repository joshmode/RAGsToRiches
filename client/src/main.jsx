import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { AuthProvider } from "./context/AuthContext"
import ErrorBoundary from "./components/ErrorBoundary"
import App from "./App"
import { applyTheme, storedTheme } from "./lib/theme"
import "./index.css"

// before the first paint, so a dark choice doesn't flash light
applyTheme(storedTheme())

createRoot(document.getElementById("root")).render(
    <StrictMode>
        <ErrorBoundary>
            <BrowserRouter>
                <AuthProvider>
                    <App />
                </AuthProvider>
            </BrowserRouter>
        </ErrorBoundary>
    </StrictMode>
)
