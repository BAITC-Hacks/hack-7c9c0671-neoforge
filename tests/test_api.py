import tempfile
import unittest
from pathlib import Path

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
            "title": "Проверенный протокол",
            "summary": report["summary"],
            "actions": [
                {key: action[key] for key in ("task", "responsible", "deadline", "status", "needs_review")}
                for action in report["actions"]
            ],
        }
        saved = self.client.put(f"/reports/{ident}", json=update)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["report"]["actions"][0]["status"], "done")
        self.assertEqual(self.client.get(f"/download/{ident}/pdf").status_code, 200)
        self.assertEqual(self.client.get(f"/download/{ident}/docx").status_code, 200)
        self.assertEqual(len(self.client.get("/reports").json()), 1)

    def test_invalid_report_id_is_rejected(self):
        self.assertEqual(self.client.get("/reports/not-safe").status_code, 404)


if __name__ == "__main__":
    unittest.main()
