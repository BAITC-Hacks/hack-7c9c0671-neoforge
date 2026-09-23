import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import app.main as main


class MeetingAssistantApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_out = main.OUT
        main.OUT = Path(self.temp.name)
        self.client = TestClient(main.app)

    def tearDown(self):
        main.OUT = self.previous_out
        self.temp.cleanup()

    def test_demo_review_and_download_workflow(self):
        created = self.client.post("/demo/1")
        self.assertEqual(created.status_code, 200)
        payload = created.json()
        ident = payload["id"]
        report = payload["report"]
        report["actions"][0].update({"status": "done", "needs_review": False})
        update = {
            "revision": report["revision"],
            "title": "Проверенный протокол",
            "summary": report["summary"],
            "actions": [
                {key: action[key] for key in ("id", "task", "responsible", "deadline", "status", "needs_review")}
                for action in report["actions"]
            ],
        }
        saved = self.client.put(f"/reports/{ident}", json=update)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["report"]["actions"][0]["status"], "done")
        self.assertEqual(saved.json()["report"]["revision"], report["revision"] + 1)
        self.assertEqual(self.client.get(f"/download/{ident}/pdf").status_code, 200)
        self.assertEqual(self.client.get(f"/download/{ident}/docx").status_code, 200)
        self.assertEqual(len(self.client.get("/reports").json()), 1)

    def test_stale_revision_is_rejected(self):
        created = self.client.post("/demo/2").json()
        report = created["report"]
        payload = {"revision": report["revision"], "title": report["title"], "summary": report["summary"], "actions": [{key: action[key] for key in ("id", "task", "responsible", "deadline", "status", "needs_review")} for action in report["actions"]]}
        self.assertEqual(self.client.put(f"/reports/{created['id']}", json=payload).status_code, 200)
        self.assertEqual(self.client.put(f"/reports/{created['id']}", json=payload).status_code, 409)

    def test_dashboard_aggregates_action_statuses(self):
        self.client.post("/demo/1")
        dashboard = self.client.get("/dashboard")
        self.assertEqual(dashboard.status_code, 200)
        self.assertEqual(dashboard.json()["reports"], 1)
        self.assertGreater(dashboard.json()["actions"], 0)

    def test_action_evidence_follows_stable_id_after_reorder(self):
        created = self.client.post("/demo/1").json()
        report = created["report"]
        original = report["actions"][1]
        reordered = [report["actions"][1], report["actions"][0]]
        payload = {"revision": report["revision"], "title": report["title"], "summary": report["summary"], "actions": [{key: action[key] for key in ("id", "task", "responsible", "deadline", "status", "needs_review")} for action in reordered]}
        saved = self.client.put(f"/reports/{created['id']}", json=payload).json()["report"]
        self.assertEqual(saved["actions"][0]["id"], original["id"])
        self.assertEqual(saved["actions"][0]["evidence"], original["evidence"])

    def test_invalid_report_id_is_rejected(self):
        self.assertEqual(self.client.get("/reports/not-safe").status_code, 404)

    def test_response_security_headers_and_request_id(self):
        response = self.client.get("/health", headers={"X-Request-ID": "test-request-42"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-request-id"], "test-request-42")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertIn(response.json()["status"], ("ready", "degraded"))

    def test_report_search_and_pagination(self):
        self.client.post("/demo/1")
        self.client.post("/demo/2")
        self.assertEqual(len(self.client.get("/reports?limit=1").json()), 1)
        found = self.client.get("/reports?q=%E2%84%962").json()
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["title"], "Совещание №2")
        self.assertIn("revision", found[0])

    def test_upload_rejects_spoofed_audio_before_models_run(self):
        response = self.client.post(
            "/process",
            data={"title": "Проверка файла", "speakers": "{}"},
            files={"audio": ("fake.mp3", b"this is not audio", "audio/mpeg")},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("does not match", response.json()["detail"])

    def test_audio_processing_job_completes_and_exposes_report(self):
        wav_header = b"RIFF" + (36).to_bytes(4, "little") + b"WAVEfmt " + b"\x00" * 32
        with patch.object(main, "transcribe", return_value=[]), patch.object(main, "diarize", return_value=[]):
            response = self.client.post(
                "/process",
                data={"title": "Фоновая обработка", "speakers": "{}"},
                files={"audio": ("meeting.wav", wav_header, "audio/wav")},
            )
        self.assertEqual(response.status_code, 202)
        job = self.client.get(f"/jobs/{response.json()['id']}")
        self.assertEqual(job.status_code, 200)
        self.assertEqual(job.json()["status"], "completed")
        report = self.client.get(f"/reports/{response.json()['id']}")
        self.assertEqual(report.status_code, 200)
        self.assertEqual(report.json()["report"]["title"], "Фоновая обработка")

    def test_duplicate_action_ids_are_rejected(self):
        created = self.client.post("/demo/1").json()
        report = created["report"]
        duplicate = {key: report["actions"][0][key] for key in ("id", "task", "responsible", "deadline", "status", "needs_review")}
        payload = {"revision": report["revision"], "title": report["title"], "summary": [], "actions": [duplicate, duplicate]}
        response = self.client.put(f"/reports/{created['id']}", json=payload)
        self.assertEqual(response.status_code, 400)

    def test_frontend_and_static_assets_are_available(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("Meeting Assistant", page.text)
        self.assertEqual(self.client.get("/static/styles.css").status_code, 200)
        self.assertEqual(self.client.get("/static/app.js").status_code, 200)


if __name__ == "__main__":
    unittest.main()
