"""Offline smoke demo from supplied written meeting references; does not use audio."""
from pathlib import Path
from app.core import make_report,reference_segments,export_pdf,export_docx
import json
root=Path(__file__).resolve().parent
out=root/'outputs';out.mkdir(exist_ok=True)
for i in (1,2):
    report=make_report(reference_segments(root/f'examples/meeting_{i}_reference.txt'),f'Совещание №{i} — демонстрация на письменном эталоне')
    target=out/f'demo_{i}';target.mkdir(exist_ok=True)
    (target/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    export_pdf(report,target/'report.pdf');export_docx(report,target/'report.docx')
    print('Meeting',i,'speakers',len({s['speaker'] for s in report['segments']}),'candidate actions',len(report['actions']))
