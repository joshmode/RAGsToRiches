import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Text, Boolean, LargeBinary, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ragstoriches.db")
os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)

_engine = create_engine(f"sqlite:///{_DB_PATH}", echo=False)
_SessionLocal = sessionmaker(bind=_engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False)
    password_hash = Column(String(128), nullable=False)
    display_name = Column(String(128), nullable=False)
    role = Column(String(16), nullable=False, default="candidate")
    email = Column(String(128), default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class Resume(Base):
    __tablename__ = "resumes"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    filename = Column(String(256), default="")
    raw_bytes = Column(LargeBinary, nullable=True)
    parsed_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)


class Analysis(Base):
    __tablename__ = "analyses"
    id = Column(Integer, primary_key=True)
    resume_id = Column(Integer, ForeignKey("resumes.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    results_json = Column(Text, default="{}")
    job_description = Column(Text, default="")
    provider = Column(String(32), default="")
    model = Column(String(64), default="")
    score_total = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class RewriteDecision(Base):
    __tablename__ = "rewrite_decisions"
    id = Column(Integer, primary_key=True)
    analysis_id = Column(Integer, ForeignKey("analyses.id"), nullable=False)
    suggestion_key = Column(String(128), nullable=False)
    decision = Column(Boolean, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Annotation(Base):
    __tablename__ = "annotations"
    id = Column(Integer, primary_key=True)
    analysis_id = Column(Integer, ForeignKey("analyses.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    suggestion_key = Column(String(128), nullable=False)
    comment = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)


class ReviewSession(Base):
    __tablename__ = "review_sessions"
    id = Column(Integer, primary_key=True)
    mentor_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_code = Column(String(12), unique=True, nullable=False)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class SessionParticipant(Base):
    __tablename__ = "session_participants"
    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("review_sessions.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    joined_at = Column(DateTime, default=datetime.utcnow)


class RevisionSnapshot(Base):
    __tablename__ = "revision_snapshots"
    id = Column(Integer, primary_key=True)
    resume_id = Column(Integer, ForeignKey("resumes.id"), nullable=False)
    analysis_id = Column(Integer, ForeignKey("analyses.id"), nullable=False)
    decisions_json = Column(Text, default="{}")
    score_total = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(_engine)


def get_session():
    return _SessionLocal()


def create_user(username: str, password_hash: str, display_name: str, role: str = "candidate", email: str = "") -> User:
    s = get_session()
    try:
        u = User(
            username=username.strip().lower(),
            password_hash=password_hash,
            display_name=display_name.strip(),
            role=role,
            email=email.strip(),
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        return u
    finally:
        s.close()


def get_user(username: str) -> User | None:
    s = get_session()
    try:
        return s.query(User).filter(User.username == username.strip().lower()).first()
    finally:
        s.close()


def save_resume(user_id: int, filename: str, raw_bytes: bytes, parsed_json: str = "{}") -> Resume:
    s = get_session()
    try:
        r = Resume(user_id=user_id, filename=filename, raw_bytes=raw_bytes, parsed_json=parsed_json)
        s.add(r)
        s.commit()
        s.refresh(r)
        return r
    finally:
        s.close()


def save_analysis(resume_id: int, user_id: int, results_json: str, job_description: str, provider: str, model: str, score_total: int) -> Analysis:
    s = get_session()
    try:
        a = Analysis(
            resume_id=resume_id, user_id=user_id, results_json=results_json,
            job_description=job_description, provider=provider, model=model, score_total=score_total,
        )
        s.add(a)
        s.commit()
        s.refresh(a)
        return a
    finally:
        s.close()


def save_decisions(analysis_id: int, decisions: dict[str, bool]) -> None:
    s = get_session()
    try:
        s.query(RewriteDecision).filter(RewriteDecision.analysis_id == analysis_id).delete()
        for k, v in decisions.items():
            s.add(RewriteDecision(analysis_id=analysis_id, suggestion_key=k, decision=v))
        s.commit()
    finally:
        s.close()


def save_annotation(analysis_id: int, user_id: int, suggestion_key: str, comment: str) -> Annotation:
    s = get_session()
    try:
        ann = Annotation(analysis_id=analysis_id, user_id=user_id, suggestion_key=suggestion_key, comment=comment.strip())
        s.add(ann)
        s.commit()
        s.refresh(ann)
        return ann
    finally:
        s.close()


def get_annotations(analysis_id: int) -> list[dict]:
    s = get_session()
    try:
        rows = s.query(Annotation, User.display_name).join(User, Annotation.user_id == User.id).filter(
            Annotation.analysis_id == analysis_id
        ).order_by(Annotation.created_at).all()
        out = []
        for ann, name in rows:
            out.append({"key": ann.suggestion_key, "comment": ann.comment, "user": name, "time": ann.created_at.isoformat()})
        return out
    finally:
        s.close()


def create_session_code(mentor_id: int) -> str:
    import secrets
    code = secrets.token_urlsafe(6)[:8].upper()
    s = get_session()
    try:
        rs = ReviewSession(mentor_id=mentor_id, session_code=code)
        s.add(rs)
        s.commit()
        return code
    finally:
        s.close()


def join_session(session_code: str, user_id: int) -> ReviewSession | None:
    s = get_session()
    try:
        rs = s.query(ReviewSession).filter(
            ReviewSession.session_code == session_code.strip().upper(),
            ReviewSession.active == True,
        ).first()
        if not rs:
            return None
        ex = s.query(SessionParticipant).filter(
            SessionParticipant.session_id == rs.id,
            SessionParticipant.user_id == user_id,
        ).first()
        if not ex:
            s.add(SessionParticipant(session_id=rs.id, user_id=user_id))
            s.commit()
        return rs
    finally:
        s.close()


def get_participants(session_code: str) -> list[dict]:
    s = get_session()
    try:
        rs = s.query(ReviewSession).filter(ReviewSession.session_code == session_code.strip().upper()).first()
        if not rs:
            return []
        rows = s.query(User).join(SessionParticipant, SessionParticipant.user_id == User.id).filter(
            SessionParticipant.session_id == rs.id
        ).all()
        return [{"id": u.id, "username": u.username, "display_name": u.display_name, "role": u.role} for u in rows]
    finally:
        s.close()


def get_candidates(mentor_id: int) -> list[dict]:
    s = get_session()
    try:
        sess = s.query(ReviewSession).filter(ReviewSession.mentor_id == mentor_id).all()
        cands = {}
        for rs in sess:
            ps = s.query(User).join(SessionParticipant, SessionParticipant.user_id == User.id).filter(
                SessionParticipant.session_id == rs.id,
                User.role == "candidate",
            ).all()
            for u in ps:
                if u.id not in cands:
                    cands[u.id] = {"id": u.id, "username": u.username, "display_name": u.display_name}
        return list(cands.values())
    finally:
        s.close()


def get_user_analyses(user_id: int) -> list[dict]:
    s = get_session()
    try:
        rows = s.query(Analysis).filter(Analysis.user_id == user_id).order_by(Analysis.created_at.desc()).all()
        out = []
        for a in rows:
            out.append({"id": a.id, "resume_id": a.resume_id, "score": a.score_total, "provider": a.provider,
                        "model": a.model, "created_at": a.created_at.isoformat()})
        return out
    finally:
        s.close()


def get_mentor_sessions(mentor_id: int) -> list[dict]:
    s = get_session()
    try:
        rows = s.query(ReviewSession).filter(ReviewSession.mentor_id == mentor_id).order_by(ReviewSession.created_at.desc()).all()
        return [{"id": rs.id, "code": rs.session_code, "active": rs.active, "created_at": rs.created_at.isoformat()} for rs in rows]
    finally:
        s.close()


init_db()
