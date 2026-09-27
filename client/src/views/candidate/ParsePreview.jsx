import { AlertTriangle, FileSearch } from "lucide-react"
import { capitalize } from "../../lib/format"

function sectionName(name) {
    return capitalize(name.toLowerCase())
}

// what the parser made of the file, shown the moment it lands, so a misread resume
// is caught before an analysis is spent on it
export function ParsePreview({ upload }) {
    if (!upload) return null
    if (upload.status === "uploading") {
        return <div className="parse-preview" role="status"><span className="spinner" /> Reading your resume…</div>
    }
    if (upload.status === "failed") return <p className="error-msg" role="alert">{upload.error}</p>

    const { sections = {}, warnings = [], ocr_used: ocrUsed, preview } = upload.parsed || {}
    const names = Object.keys(sections).filter(name => name !== "HEADER" && sections[name].length)
    return <div className="parse-preview" role="status">
        <p className="parse-preview-line">
            <FileSearch size={14} />
            <span>
                {names.length
                    ? <>Found {names.length} section{names.length === 1 ? "" : "s"}: {names.map(name => `${sectionName(name)} (${sections[name].length})`).join(", ")}.</>
                    : "No sections found. Check the file is a resume with headings before analysing."}
            </span>
        </p>
        {preview && <p className="parse-preview-line parse-preview-score">
            <b>{preview.score.total}/100</b>
            <span>
                on the rubric as it stands. {preview.to_rewrite} line{preview.to_rewrite === 1 ? "" : "s"} to rewrite
                {preview.already_strong ? `, ${preview.already_strong} already strong` : ""}. It scores your own bullets,
                so it moves when you upload a revised resume, not when you accept a rewrite.
            </span>
        </p>}
        {ocrUsed && <p className="parse-preview-line muted">This was a scanned PDF, so the text was read with OCR. Check the extracted sections once it's analysed.</p>}
        {warnings.map(warning => <p className="parse-preview-line parse-preview-warning" key={warning}><AlertTriangle size={14} /> <span>{warning}</span></p>)}
    </div>
}
