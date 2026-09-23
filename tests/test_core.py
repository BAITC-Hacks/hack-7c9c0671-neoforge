import json
import tempfile
import unittest
from pathlib import Path

from app.core import Segment, export_docx, export_pdf, make_report, reference_segments


ROOT = Path(__file__).resolve().parents[1]


class MeetingAssistantTests(unittest.TestCase):
    def test_kazakh_action_and_deadline(self):
        report = make_report([Segment(1, 4, "SPEAKER_00", "Айдана Серікқызы, есепті бір апта ішінде дайындау.")], "Тест")
        self.assertEqual(report["actions"][0]["responsible"], "Айдана Серікқызы")
        self.assertEqual(report["actions"][0]["deadline"], "бір апта ішінде")

    def test_reference_samples_are_parseable(self):
        for meeting_id in (1, 2):
            report = make_report(reference_segments(ROOT / "examples" / f"meeting_{meeting_id}_reference.txt"), "Тест")
            self.assertGreaterEqual(report["stats"]["speakers"], 4)
            self.assertGreaterEqual(report["stats"]["actions"], 4)

    def test_exports(self):
        report = make_report([Segment(0, 3, "SPEAKER_00", "Ответственный: Айдана Серікқызы. Подготовить отчёт до пятницы.")], "Экспорт")
        with tempfile.TemporaryDirectory() as folder:
            pdf = Path(folder) / "report.pdf"
            docx = Path(folder) / "report.docx"
            export_pdf(report, pdf)
            export_docx(report, docx)
            self.assertTrue(pdf.read_bytes().startswith(b"%PDF"))
            self.assertTrue(docx.read_bytes().startswith(b"PK"))


if __name__ == "__main__":
    unittest.main()
