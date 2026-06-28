import html
import streamlit as st

try:
    import altair as alt
    import pandas as pd
    ALTAIR_AVAILABLE = True
except ImportError:
    ALTAIR_AVAILABLE = False

from db import (
    get_candidates, get_user_analyses, get_mentor_sessions,
    create_session_code, get_participants,
)


def _summary(c: dict) -> dict:
    arr = get_user_analyses(c["id"])
    scores = []
    for a in arr:
        scores.append(a["score"])
    return {
        "id": c["id"],
        "name": c["display_name"],
        "username": c["username"],
        "total_analyses": len(arr),
        "latest_score": scores[0] if scores else 0,
        "best_score": max(scores) if scores else 0,
        "scores": scores,
    }


def render_dash(user_id: int) -> None:
    st.markdown('<span class="section-label">Mentor Dashboard</span>', unsafe_allow_html=True)

    c1, c2 = st.columns([2, 1])
    with c1:
        sessions = get_mentor_sessions(user_id)
        if sessions:
            active = [s for s in sessions if s["active"]]
            st.markdown(
                f'<div class="card"><span class="section-label">Active Sessions</span>'
                f'<p style="font-size:0.85rem;color:#6B7280;">{len(active)} active review session{"s" if len(active) != 1 else ""}</p></div>',
                unsafe_allow_html=True,
            )
            for s in active:
                ps = get_participants(s["code"])
                names = ", ".join(p["display_name"] for p in ps) or "No participants yet"
                st.markdown(
                    f'<div class="card" style="padding:0.75rem 1rem;">'
                    f'<span style="font-family:monospace;font-size:1.1rem;font-weight:700;color:#8b5cf6;">{s["code"]}</span>'
                    f'<span style="font-size:0.78rem;color:#6B7280;margin-left:1rem;">{names}</span>'
                    f'</div>',
                    unsafe_allow_html=True,
                )
        else:
            st.markdown(
                '<p style="color:#6B7280;font-size:0.85rem;">No review sessions yet. Create one to start collaborating.</p>',
                unsafe_allow_html=True,
            )
    with c2:
        if st.button("Create Review Session", use_container_width=True):
            code = create_session_code(user_id)
            st.success(f"Session created! Share this code with your candidates: **{code}**")
            st.rerun()

    st.markdown('<hr class="slim-divider">', unsafe_allow_html=True)

    candidates = get_candidates(user_id)
    if not candidates:
        st.info("No candidates have joined your review sessions yet. Share a session code to get started.")
        return

    sums = []
    for c in candidates:
        sums.append(_summary(c))

    st.markdown('<span class="section-label">Candidate Comparison</span>', unsafe_allow_html=True)

    h = '<div class="card"><table style="width:100%;border-collapse:collapse;font-size:0.84rem;">'
    h += '<tr style="border-bottom:1px solid #E8EAED;">'
    h += '<th style="text-align:left;padding:0.5rem;">Candidate</th>'
    h += '<th style="text-align:center;padding:0.5rem;">Analyses</th>'
    h += '<th style="text-align:center;padding:0.5rem;">Latest Score</th>'
    h += '<th style="text-align:center;padding:0.5rem;">Best Score</th>'
    h += '</tr>'
    for s in sums:
        col = "#15C39A" if s["latest_score"] >= 70 else "#E8A735" if s["latest_score"] >= 50 else "#E5534B"
        h += f'<tr style="border-bottom:1px solid #F7F8FA;">'
        h += f'<td style="padding:0.5rem;font-weight:600;">{html.escape(s["name"])}</td>'
        h += f'<td style="text-align:center;padding:0.5rem;">{s["total_analyses"]}</td>'
        h += f'<td style="text-align:center;padding:0.5rem;color:{col};font-weight:700;">{s["latest_score"]}</td>'
        h += f'<td style="text-align:center;padding:0.5rem;">{s["best_score"]}</td>'
        h += '</tr>'
    h += '</table></div>'
    st.markdown(h, unsafe_allow_html=True)

    if ALTAIR_AVAILABLE and any(len(s["scores"]) > 1 for s in sums):
        st.markdown('<span class="section-label" style="margin-top:1rem;">Score Progression</span>', unsafe_allow_html=True)
        rows = []
        for s in sums:
            for i, sc in enumerate(reversed(s["scores"])):
                rows.append({"Candidate": s["name"], "Attempt": i + 1, "Score": sc})
        if rows:
            df = pd.DataFrame(rows)
            chart = (
                alt.Chart(df)
                .mark_line(point=alt.OverlayMarkDef(filled=True, size=50), strokeWidth=2)
                .encode(
                    x=alt.X("Attempt:Q", title="Attempt", axis=alt.Axis(tickMinStep=1, format="d")),
                    y=alt.Y("Score:Q", title="Score", scale=alt.Scale(domain=[0, 100])),
                    color=alt.Color("Candidate:N"),
                    tooltip=["Candidate:N", "Attempt:Q", "Score:Q"],
                )
                .properties(height=220)
            )
            st.altair_chart(chart, use_container_width=True)

    for s in sums:
        with st.expander(f"{s['name']} - {s['total_analyses']} analyses, latest: {s['latest_score']}/100"):
            arr = get_user_analyses(s["id"])
            for a in arr[:10]:
                st.markdown(
                    f'<div style="font-size:0.82rem;padding:0.3rem 0;border-bottom:1px solid #F7F8FA;">'
                    f'<span style="font-weight:600;">Score: {a["score"]}/100</span>'
                    f'<span style="color:#6B7280;margin-left:1rem;">{a["provider"]} / {a["model"]}</span>'
                    f'<span style="color:#6B7280;margin-left:1rem;">{a["created_at"][:16]}</span>'
                    f'</div>',
                    unsafe_allow_html=True,
                )


def export_report(user_id: int) -> str:
    candidates = get_candidates(user_id)
    sums = []
    for c in candidates:
        sums.append(_summary(c))

    lines = ["# Mentor Review Report\n"]
    for s in sums:
        lines.append(f"## {s['name']} (@{s['username']})")
        lines.append(f"- Total analyses: {s['total_analyses']}")
        lines.append(f"- Latest score: {s['latest_score']}/100")
        lines.append(f"- Best score: {s['best_score']}/100")
        if s["scores"]:
            lines.append(f"- Score history: {', '.join(str(x) for x in reversed(s['scores']))}")
        lines.append("")
    return "\n".join(lines)
