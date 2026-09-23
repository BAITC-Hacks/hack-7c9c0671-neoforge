from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .core import diarize, export_docx, export_pdf, make_report, reference_segments, transcribe

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs"
EXAMPLES = ROOT / "examples"
OUT.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
app = FastAPI(title="Meeting Assistant", version="1.0.0", description="On-premise meeting protocol prototype")
app.mount("/static", StaticFiles(directory=ROOT / "app" / "static"), name="static")


class ActionUpdate(BaseModel):
    task: str = Field(min_length=2, max_length=500)
    responsible: str = Field(min_length=1, max_length=120)
    deadline: str = Field(min_length=1, max_length=120)
    status: Literal["draft", "in_progress", "done"] = "draft"
    needs_review: bool = True


class ReportUpdate(BaseModel):
    title: str = Field(min_length=2, max_length=150)
    summary: list[str] = Field(default_factory=list, max_length=12)
    actions: list[ActionUpdate] = Field(default_factory=list, max_length=100)


def _safe_error(exc: Exception) -> str:
    return str(exc) if isinstance(exc, (FileNotFoundError, RuntimeError)) else "Processing failed. Check local models and server logs."


def write_report(report: dict, target: Path) -> None:
    """Generate every representation before atomically replacing the public files."""
    json_temp = target / "report.json.tmp"
    docx_temp = target / "report.docx.tmp"
    pdf_temp = target / "report.pdf.tmp"
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
        return json.loads(_report_path(ident).read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(500, "Stored report is damaged") from exc


def _create_result(segments, title: str, source: str) -> dict:
    ident = uuid.uuid4().hex
    target = OUT / ident
    target.mkdir()
    try:
        report = make_report(segments, title[:150])
        report["source"] = source
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
    return {"status": "ok", "asr_model": asr.is_dir(), "diarization_model": diarization.is_dir(), "demo_available": True}


@app.get("/reports")
def reports() -> list[dict]:
    """Return lightweight metadata for the local review dashboard."""
    items: list[dict] = []
    for path in OUT.glob("*/report.json"):
        if not re.fullmatch(r"[a-f0-9]{32}", path.parent.name):
            continue
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
            items.append({"id": path.parent.name, "title": report.get("title", "Протокол"), "created_at": report.get("created_at", ""), "source": report.get("source", "unknown"), "stats": report.get("stats", {})})
        except (OSError, json.JSONDecodeError):
            continue
    return sorted(items, key=lambda item: item["created_at"], reverse=True)[:50]


@app.get("/reports/{ident}")
def get_report(ident: str) -> dict:
    return {"id": ident, "report": _load_report(ident)}


@app.put("/reports/{ident}")
def update_report(ident: str, update: ReportUpdate) -> dict:
    """Save secretary-reviewed fields while preserving evidence and transcript."""
    report = _load_report(ident)
    existing = report.get("actions", [])
    actions: list[dict] = []
    for index, action_update in enumerate(update.actions):
        values = action_update.model_dump() if hasattr(action_update, "model_dump") else action_update.dict()
        preserved = existing[index] if index < len(existing) else {}
        actions.append({**preserved, **values})
    report["title"] = update.title.strip()
    report["summary"] = [item.strip() for item in update.summary if item.strip()]
    report["actions"] = actions
    report["review_required"] = any(action["needs_review"] for action in actions)
    report["stats"] = {**report.get("stats", {}), "actions": len(actions), "needs_review": sum(action["needs_review"] for action in actions), "done": sum(action["status"] == "done" for action in actions)}
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


@app.post("/process")
async def process(audio: UploadFile = File(...), title: str = Form("Протокол совещания"), speakers: str = Form("{}")) -> dict:
    suffix = Path(audio.filename or "").suffix.lower()
    if suffix not in (".mp3", ".wav", ".m4a", ".ogg"):
        raise HTTPException(400, "Supported formats: MP3, WAV, M4A, OGG")
    try:
        mapping = json.loads(speakers or "{}")
        if not isinstance(mapping, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in mapping.items()):
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
        segments = transcribe(input_path, Path(os.getenv("ASR_MODEL_DIR", "models/faster-whisper-small")))
        segments = diarize(segments, input_path, Path(os.getenv("DIARIZATION_MODEL_DIR", "models/pyannote-speaker-diarization")))
        for segment in segments:
            segment.speaker = mapping.get(segment.speaker, segment.speaker)
        report = make_report(segments, title[:150])
        report["source"] = "local_audio"
        write_report(report, target)
        return {"id": ident, "report": report}
    except HTTPException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(target, ignore_errors=True)
        raise HTTPException(422, _safe_error(exc)) from exc
    finally:
        input_path.unlink(missing_ok=True)


@app.get("/download/{ident}/{kind}")
def download(ident: str, kind: str):
    if not re.fullmatch(r"[a-f0-9]{32}", ident) or kind not in ("json", "pdf", "docx"):
        raise HTTPException(404)
    path = OUT / ident / f"report.{kind}"
    if not path.is_file():
        raise HTTPException(404)
    media = {"json": "application/json", "pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
    return FileResponse(path, filename=f"meeting-protocol.{kind}", media_type=media[kind])
