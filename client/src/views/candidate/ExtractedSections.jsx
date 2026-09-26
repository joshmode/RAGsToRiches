export function ExtractedSections({ result }) {
    return <div><h2 className="view-title">Extracted Sections</h2>{Object.entries(result.sections || {}).map(([name, lines]) => <details className="card" key={name} open={name === "EXPERIENCE"}><summary>{name}</summary><pre className="section-pre">{lines.join("\n")}</pre></details>)}</div>
}
