import dotenv from "dotenv"
import path from "path"
import { fileURLToPath } from "url"

// Static imports are evaluated before a module's body runs, so every module that
// reads configuration at import time must import this first. Otherwise a local
// `.env` is loaded too late and the process silently uses development fallbacks.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.resolve(__dirname, "..", ".env") })
