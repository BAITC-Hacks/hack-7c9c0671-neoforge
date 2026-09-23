from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .core import diarize, export_docx, export_pdf, make_report, reference_segments, transcribe

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs"
EXAMPLES = ROOT / "examples"
OUT.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
REPORT_WRITE_LOCK = RLock()
app = FastAPI(title="Meeting Assistant", version="1.0.0", description="On-premise meeting protocol prototype")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.mount("/static", StaticFiles(directory=ROOT / "app" / "static"), name="static")


@app.middleware("http")
async def response_headers(request: Request, call_next):
    request_id = re.sub(r"[^A-Za-z0-9._-]", "", request.headers.get("x-request-id", ""))[:128] or uuid.uuid4().hex
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


class ActionUpdate(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    task: str = Field(min_length=2, max_length=500)
    responsible: str = Field(min_length=1, max_length=120)
    deadline: str = Field(min_length=1, max_length=120)
    status: Literal["draft", "in_progress", "done"] = "draft"
    needs_review: bool = True


class ReportUpdate(BaseModel):
    revision: int = Field(ge=1)
    title: str = Field(min_length=2, max_length=150)
    summary: list[str] = Field(default_factory=list, max_length=12)
    actions: list[ActionUpdate] = Field(default_factory=list, max_length=100)


def _safe_error(exc: Exception) -> str:
    return str(exc) if isinstance(exc, (FileNotFoundError, RuntimeError)) else "Processing failed. Check local models and server logs."


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _looks_like_audio(path: Path, suffix: str) -> bool:
    with path.open("rb") as stream:
        header = stream.read(16)
    checks = {
        ".wav": lambda value: value.startswith(b"RIFF") and value[8:12] == b"WAVE",
        ".ogg": lambda value: value.startswith(b"OggS"),
        ".m4a": lambda value: len(value) >= 12 and value[4:8] == b"ftyp",
        ".mp3": lambda value: value.startswith(b"ID3") or (len(value) >= 2 and value[0] == 0xFF and value[1] & 0xE0 == 0xE0),
    }
    return bool(header) and checks[suffix](header)


def _job_path(ident: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{32}", ident):
        raise HTTPException(404)
    return OUT / "_jobs" / f"{ident}.json"


def _write_job(ident: str, **values) -> dict:
    path = _job_path(ident)
    path.parent.mkdir(exist_ok=True)
    with REPORT_WRITE_LOCK:
        current = {}
        if path.is_file():
            try:
                current = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                current = {}
        job = {**current, **values, "id": ident, "updated_at": _now()}
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)
        return job


def _run_audio_job(ident: str, input_path: Path, title: str, mapping: dict[str, str]) -> None:
    target = OUT / ident
    try:
        _write_job(ident, status="processing", stage="transcription", progress=20)
        segments = transcribe(input_path, Path(os.getenv("ASR_MODEL_DIR", "models/faster-whisper-small")))
        _write_job(ident, stage="diarization", progress=55)
        segments = diarize(segments, input_path, Path(os.getenv("DIARIZATION_MODEL_DIR", "models/pyannote-speaker-diarization")))
        for segment in segments:
            segment.speaker = mapping.get(segment.speaker, segment.speaker)
        _write_job(ident, stage="report", progress=80)
        report = make_report(segments, title)
        report["source"] = "local_audio"
        report["schema_version"] = 2
        report["updated_at"] = report["created_at"]
        write_report(report, target)
        _write_job(ident, status="completed", stage="completed", progress=100, report_id=ident)
    except Exception as exc:
        shutil.rmtree(target, ignore_errors=True)
        _write_job(ident, status="failed", stage="failed", progress=100, error=_safe_error(exc))
    finally:
        input_path.unlink(missing_ok=True)


def write_report(report: dict, target: Path) -> None:
    """Generate every representation before atomically replacing the public files."""
    json_temp = target / "report.json.tmp"
    docx_temp = target / "report.docx.tmp"
    pdf_temp = target / "report.pdf.tmp"
    with REPORT_WRITE_LOCK:
        try:
            json_temp.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            export_docx(report, docx_temp)
            export_pdf(report, pdf_temp)
            json_temp.replace(target / "report.json")
            docx_temp.replace(target / "report.docx")
            pdf_temp.replace(target / "report.pdf")
        finally:
            for temporary in (json_temp, docx_temp, pdf_temp):
                temporary.unlink(missing_ok=True)


def _report_path(ident: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{32}", ident):
        raise HTTPException(404)
    path = OUT / ident / "report.json"
    if not path.is_file():
        raise HTTPException(404)
    return path


def _load_report(ident: str) -> dict:
    try:
        report = json.loads(_report_path(ident).read_text(encoding="utf-8"))
        report.setdefault("revision", 1)
        for index, action in enumerate(report.setdefault("actions", [])):
            legacy_id = uuid.uuid5(uuid.NAMESPACE_URL, f"{ident}:{index}:{action.get('task', '')}").hex
            action.setdefault("id", legacy_id)
            action.setdefault("status", "draft")
            action.setdefault("needs_review", True)
        return report
    except json.JSONDecodeError as exc:
        raise HTTPException(500, "Stored report is damaged") from exc


def _create_result(segments, title: str, source: str) -> dict:
    ident = uuid.uuid4().hex
    target = OUT / ident
    target.mkdir()
    try:
        report = make_report(segments, title[:150])
        report["source"] = source
        report["schema_version"] = 2
        report["updated_at"] = report["created_at"]
        write_report(report, target)
        return {"id": ident, "report": report}
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (ROOT / "app" / "index.html").read_text(encoding="utf-8")


@app.get("/health")
def health() -> dict:
    asr = Path(os.getenv("ASR_MODEL_DIR", "models/faster-whisper-small"))
    diarization = Path(os.getenv("DIARIZATION_MODEL_DIR", "models/pyannote-speaker-diarization"))
    ffmpeg = shutil.which("ffmpeg") is not None
    asr_ready = (asr / "model.bin").is_file()
    diarization_ready = diarization.is_dir() and any(diarization.glob("*.yaml"))
    return {
        "status": "ready" if asr_ready and diarization_ready and ffmpeg else "degraded",
        "version": app.version,
        "asr_model": (asr / "model.bin").is_file(),
        "diarization_model": diarization_ready,
        "ffmpeg": ffmpeg,
        "demo_available": True,
        "storage_writable": os.access(OUT, os.W_OK),
    }


@app.get("/dashboard")
def dashboard() -> dict:
    totals = {"reports": 0, "actions": 0, "draft": 0, "in_progress": 0, "done": 0, "needs_review": 0}
    for path in OUT.glob("*/report.json"):
        if not re.fullmatch(r"[a-f0-9]{32}", path.parent.name):
            continue
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        totals["reports"] += 1
        for action in report.get("actions", []):
            totals["actions"] += 1
            status = action.get("status", "draft")
            totals[status if status in ("draft", "in_progress", "done") else "draft"] += 1
            totals["needs_review"] += bool(action.get("needs_review", True))
    totals["completion_percent"] = round(totals["done"] * 100 / totals["actions"]) if totals["actions"] else 0
    return totals


@app.get("/reports")
def reports(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), q: str = Query("", max_length=100)) -> list[dict]:
    """Return lightweight metadata for the local review dashboard."""
    items: list[dict] = []
    for path in OUT.glob("*/report.json"):
        if not re.fullmatch(r"[a-f0-9]{32}", path.parent.name):
            continue
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
            title = report.get("title", "Протокол")
            if q and q.casefold() not in title.casefold():
                continue
            items.append({"id": path.parent.name, "title": title, "created_at": report.get("created_at", ""), "updated_at": report.get("updated_at", report.get("created_at", "")), "revision": report.get("revision", 1), "source": report.get("source", "unknown"), "stats": report.get("stats", {})})
        except (OSError, json.JSONDecodeError):
            continue
    return sorted(items, key=lambda item: item["updated_at"], reverse=True)[offset:offset + limit]


@app.get("/reports/{ident}")
def get_report(ident: str) -> dict:
    return {"id": ident, "report": _load_report(ident)}


@app.get("/jobs/{ident}")
def get_job(ident: str) -> dict:
    path = _job_path(ident)
    if not path.is_file():
        raise HTTPException(404)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(500, "Stored job is damaged") from exc


@app.put("/reports/{ident}")
def update_report(ident: str, update: ReportUpdate) -> dict:
    """Save secretary-reviewed fields while preserving evidence and transcript."""
    with REPORT_WRITE_LOCK:
        report = _load_report(ident)
        if update.revision != report["revision"]:
            raise HTTPException(409, "Report changed in another window. Reload it before saving.")
        action_ids = [action.id for action in update.actions]
        if len(action_ids) != len(set(action_ids)):
            raise HTTPException(400, "Action IDs must be unique")
        if not update.title.strip():
            raise HTTPException(400, "Title cannot be blank")
        existing_by_id = {action["id"]: action for action in report.get("actions", [])}
        actions: list[dict] = []
        for action_update in update.actions:
            values = action_update.model_dump() if hasattr(action_update, "model_dump") else action_update.dict()
            preserved = existing_by_id.get(values["id"], {})
            actions.append({**preserved, **values})
        report["title"] = update.title.strip()
        report["summary"] = [item.strip() for item in update.summary if item.strip()]
        report["actions"] = actions
        report["revision"] += 1
        report["schema_version"] = 2
        report["updated_at"] = _now()
        report["review_required"] = any(action["needs_review"] for action in actions)
        report["stats"] = {**report.get("stats", {}), "actions": len(actions), "needs_review": sum(action["needs_review"] for action in actions), "draft": sum(action["status"] == "draft" for action in actions), "in_progress": sum(action["status"] == "in_progress" for action in actions), "done": sum(action["status"] == "done" for action in actions)}
        write_report(report, _report_path(ident).parent)
        return {"id": ident, "report": report}


@app.post("/demo/{meeting_id}")
def demo(meeting_id: int) -> dict:
    if meeting_id not in (1, 2):
        raise HTTPException(404, "Unknown demo")
    try:
        path = EXAMPLES / f"meeting_{meeting_id}_reference.txt"
        return _create_result(reference_segments(path), f"Совещание №{meeting_id}", "provided_reference_text")
    except Exception as exc:
        raise HTTPException(500, _safe_error(exc)) from exc


@app.post("/process", status_code=202)
async def process(background_tasks: BackgroundTasks, audio: UploadFile = File(...), title: str = Form("Протокол совещания"), speakers: str = Form("{}")) -> dict:
    suffix = Path(audio.filename or "").suffix.lower()
    if suffix not in (".mp3", ".wav", ".m4a", ".ogg"):
        raise HTTPException(400, "Supported formats: MP3, WAV, M4A, OGG")
    title = title.strip()
    if len(title) < 2 or len(title) > 150:
        raise HTTPException(400, "Title must contain 2 to 150 characters")
    try:
        mapping = json.loads(speakers or "{}")
        if not isinstance(mapping, dict) or len(mapping) > 100 or not all(isinstance(k, str) and isinstance(v, str) and 1 <= len(k) <= 80 and 1 <= len(v.strip()) <= 120 for k, v in mapping.items()):
            raise ValueError
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "speakers must be a string-to-string JSON object") from exc
    ident = uuid.uuid4().hex
    target = OUT / ident
    target.mkdir()
    input_path = target / f"recording{suffix}"
    total = 0
    try:
        with input_path.open("wb") as stream:
            while chunk := await audio.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Maximum upload size is 100 MB")
                stream.write(chunk)
        if not _looks_like_audio(input_path, suffix):
            raise HTTPException(400, "File content does not match its audio extension")
        job = _write_job(ident, status="queued", stage="upload", progress=5, created_at=_now())
        background_tasks.add_task(_run_audio_job, ident, input_path, title, mapping)
        return job
    except HTTPException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(target, ignore_errors=True)
        raise HTTPException(422, _safe_error(exc)) from exc


@app.get("/download/{ident}/{kind}")
def download(ident: str, kind: str):
    if not re.fullmatch(r"[a-f0-9]{32}", ident) or kind not in ("json", "pdf", "docx"):
        raise HTTPException(404)
    path = OUT / ident / f"report.{kind}"
    if not path.is_file():
        raise HTTPException(404)
    media = {"json": "application/json", "pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
    return FileResponse(path, filename=f"meeting-protocol.{kind}", media_type=media[kind])
