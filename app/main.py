from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

from .core import diarize, export_docx, export_pdf, make_report, reference_segments, transcribe

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs"
EXAMPLES = ROOT / "examples"
OUT.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
app = FastAPI(title="Meeting Assistant", version="1.0.0", description="On-premise meeting protocol prototype")


def _safe_error(exc: Exception) -> str:
    return str(exc) if isinstance(exc, (FileNotFoundError, RuntimeError)) else "Processing failed. Check local models and server logs."


def write_report(report: dict, target: Path) -> None:
    (target / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    export_docx(report, target / "report.docx")
    export_pdf(report, target / "report.pdf")


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
