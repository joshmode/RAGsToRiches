import { useEffect, useMemo, useRef, useState } from "react"
import * as pdfjs from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { findRange, pageText, rangeRects } from "../lib/pdfText"

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// severity in words as well as colour
const SEVERITY_LABEL = { red: "Weak bullet", yellow: "Could be stronger", green: "Already strong" }

// Renders the resume in the browser and draws the suggestion highlights over it.
// Picking a suggestion used to re-upload the whole PDF for the engine to highlight
// and reload the viewer, now it's a scroll. Default export so it can load lazily,
// pdf.js is most of a megabyte.
export default function PdfViewer({ file, highlights = [], activeId = "", title = "Resume" }) {
    const wrapRef = useRef(null)
    const scrollRef = useRef(null)
    const [width, setWidth] = useState(0)
    const [pages, setPages] = useState([])
    const [error, setError] = useState("")

    useEffect(() => {
        const node = wrapRef.current
        if (!node) return undefined
        const observer = new ResizeObserver(entries => {
            const next = Math.floor(entries[0].contentRect.width) - 24
            // a scrollbar appearing isn't worth re-rendering every page for
            setWidth(prev => (Math.abs(prev - next) > 24 ? next : prev))
        })
        observer.observe(node)
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        if (!file || width <= 0) return undefined
        let cancelled = false
        let doc = null
        async function render() {
            try {
                const data = new Uint8Array(await file.arrayBuffer())
                // eval off: pdf.js otherwise compiles font code on the fly
                doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
                const rendered = []
                for (let number = 1; number <= doc.numPages; number++) {
                    const page = await doc.getPage(number)
                    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width })
                    const ratio = window.devicePixelRatio || 1
                    const canvas = document.createElement("canvas")
                    canvas.width = Math.floor(viewport.width * ratio)
                    canvas.height = Math.floor(viewport.height * ratio)
                    canvas.style.width = `${viewport.width}px`
                    canvas.style.height = `${viewport.height}px`
                    await page.render({
                        canvasContext: canvas.getContext("2d"), viewport,
                        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
                    }).promise
                    const content = await page.getTextContent()
                    rendered.push({ number, viewport, canvas, text: pageText(content.items) })
                    if (cancelled) return
                }
                setPages(rendered)
                setError("")
            } catch {
                if (!cancelled) setError("This PDF couldn't be displayed. The suggestions still work without it.")
            }
        }
        render()
        return () => {
            cancelled = true
            doc?.destroy()
        }
    }, [file, width])

    const marks = useMemo(() => pages.map(page => {
        const toViewport = item => {
            const tx = pdfjs.Util.transform(page.viewport.transform, item.transform)
            const height = Math.hypot(tx[2], tx[3])
            return { left: tx[4], top: tx[5] - height, width: item.width * page.viewport.scale, height: height * 1.2 }
        }
        return highlights.flatMap(highlight => {
            const range = findRange(page.text, highlight.text)
            if (!range) return []
            return rangeRects(page.text, range, toViewport)
                .map((rect, i) => ({ ...rect, id: highlight.id, severity: highlight.severity, key: `${highlight.id}-${i}` }))
        })
    }), [pages, highlights])

    // bring the active suggestion into view inside the viewer, not the whole page
    useEffect(() => {
        const scroller = scrollRef.current
        const mark = activeId && scroller?.querySelector(`[data-highlight="${CSS.escape(activeId)}"]`)
        if (!mark) return
        const top = mark.parentElement.offsetTop + mark.offsetTop
        scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: "smooth" })
    }, [activeId, marks])

    return <div className="pdf-viewer" ref={wrapRef}>
        {error && <p className="muted pdf-viewer-note">{error}</p>}
        {!error && !pages.length && <p className="muted pdf-viewer-note">Loading the preview…</p>}
        <div className="pdf-viewer-scroll" ref={scrollRef} role="document" aria-label={title}>
            {pages.map((page, idx) => <div className="pdf-page" key={page.number} style={{ width: page.viewport.width, height: page.viewport.height }}>
                <div ref={node => { if (node && node.firstChild !== page.canvas) node.replaceChildren(page.canvas) }} />
                {marks[idx].map(mark => <span
                    key={mark.key} data-highlight={mark.id} title={SEVERITY_LABEL[mark.severity]}
                    className={`pdf-mark pdf-mark-${mark.severity || "yellow"} ${mark.id === activeId ? "active" : ""}`}
                    style={{ left: mark.left, top: mark.top, width: mark.width, height: mark.height }}
                />)}
            </div>)}
        </div>
    </div>
}
