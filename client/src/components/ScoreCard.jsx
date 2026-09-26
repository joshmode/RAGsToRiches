import { useEffect, useRef, useState } from "react"
import { Mail, TrendingDown, TrendingUp } from "lucide-react"
import { getScoreCfg, heatmapQuality, isGraded, scoreBreakdown } from "../lib/score"

function useCountUp(target, duration = 700) {
    const [display, setDisplay] = useState(target)
    const prevRef = useRef(target)
    useEffect(() => {
        const start = prevRef.current
        if (start === target) return undefined
        const startTime = performance.now()
        let raf
        function tick(now) {
            const progress = Math.min(1, (now - startTime) / duration)
            setDisplay(Math.round(start + (target - start) * progress))
            if (progress < 1) raf = requestAnimationFrame(tick)
            else prevRef.current = target
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [target, duration])
    return display
}

// their own past attempts are the benchmark
function ownStanding(score, history) {
    if (!history || history.length < 2) return null
    const past = history.slice(1)
    if (past.every(h => score > h.score)) return "Your best score yet"
    const better = past.filter(h => h.score < score).length
    if (better === 0) return "Your lowest score yet"
    return `Better than ${Math.round((better / past.length) * 100)}% of your past attempts`
}

export function ScoreCard({ scoreData, history, attemptType }) {
    // hooks before the early return below 
    const score = typeof scoreData === "object" ? scoreData?.total || 0 : scoreData || 0
    const displayScore = useCountUp(score)

    // never ran analyse(), and 0/100 reads as a bad score not n/a
    if (attemptType === "cover_letter_only") {
        return <div className="card score-card score-card-cover-letter-only">
            <span className="section-label">Resume Score</span>
            <div className="score-cta">
                <Mail size={22} />
                <p className="muted">This was a fast Cover Letter attempt - no scoring or rewrite suggestions were generated.</p>
            </div>
        </div>
    }
    const cfg = getScoreCfg(score)
    const lines = scoreBreakdown(scoreData)
    const sectionScores = (typeof scoreData === "object" && scoreData?.section_scores) || {}
    const previousScore = history && history.length > 1 ? history[1].score : null
    const delta = previousScore != null ? score - previousScore : null
    const standing = ownStanding(score, history)

    return <div className="card score-card">
        <span className="section-label">Resume Score</span>
        <div className="score-tooltip-wrap">
            <div className="score-stack">
                <div className="score-ring" style={{ "--pct": score, "--ring-color": cfg.color }}>
                    <div className="score-ring-inner">
                        <div className="score-number" style={{ color: cfg.color }}>{displayScore}</div>
                        <span className="score-label-text" style={{ color: cfg.color }}>{cfg.label}</span>
                    </div>
                </div>
                <span className="score-sub">out of 100 · hover for breakdown</span>
                {delta !== null && delta !== 0 && (
                    <span className={`score-delta ${delta > 0 ? "up" : "down"}`}>
                        {delta > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                        {delta > 0 ? "+" : ""}{delta} since last analysis
                    </span>
                )}
                {standing && <span className="score-benchmark">{standing}</span>}
            </div>
            <div className="score-tooltip">
                {lines.map(line => <div key={line}>{line}</div>)}
                {Object.keys(sectionScores).length > 0 && <>
                    <div className="tooltip-divider" />
                    <div className="tooltip-heat-label">Section strength</div>
                    {Object.entries(sectionScores).map(([sec, data]) => {
                        const hq = heatmapQuality(isGraded(data) ? data.quality : null)
                        return <div className="tooltip-heat-row" key={sec}>
                            <span className="heat-swatch" style={{ background: hq.color }} />
                            <span>{sec[0] + sec.slice(1).toLowerCase()}</span>
                            <span className="tooltip-heat-tag">{hq.label}</span>
                        </div>
                    })}
                </>}
            </div>
        </div>
    </div>
}
