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

    def test_addressee_carries_to_following_sentence(self):
        report = make_report(
            [Segment(1, 8, "CHAIR", "Нурлан Сагатович, ситуация понятна? Так проверьте все площадки до пятницы.")],
            "Тест",
        )
        self.assertEqual(report["actions"][0]["responsible"], "Нурлан Сагатович")
        self.assertFalse(report["actions"][0]["needs_review"])

    def test_first_person_commitment_belongs_to_speaker(self):
        report = make_report([Segment(2, 5, "Айнур Каировна", "Хорошо, запрошу заключение у юристов к среде.")], "Тест")
        self.assertEqual(report["actions"][0]["responsible"], "Айнур Каировна")

    def test_numbered_item_does_not_inherit_previous_responsible(self):
        report = make_report(
            [Segment(0, 8, "Председатель Правления", "Тимур Болатович, подготовьте решение. Четвёртое: провести юридическую проверку до пятницы.")],
            "Тест",
        )
        self.assertEqual(report["actions"][1]["responsible"], "Не указан / көрсетілмеген")

    def test_tiny_verb_fragment_is_not_an_action(self):
        report = make_report([Segment(0, 2, "Руководитель Отдела", "Нужно проверить.")], "Тест")
        self.assertEqual(report["actions"], [])

    def test_previous_speaker_is_not_assigned_to_an_infinitive_proposal(self):
        report = make_report(
            [
                Segment(0, 2, "Асхат Ерланович", "Какие есть предложения?"),
                Segment(2, 5, "Гульмира Сериковна", "Предлагаю провести совещание до пятницы."),
            ],
            "Тест",
        )
        self.assertEqual(report["actions"][0]["responsible"], "Не указан / көрсетілмеген")

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
