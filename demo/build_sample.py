"""Render demo/sample_resume.txt to client/public/sample-resume.pdf, and copy the
sample job ad next to it, for the landing page's "Try a sample resume".

    python demo/build_sample.py

Both are committed so the client can serve them. Re-run this after editing either
text, and update demo/replay.json if a bullet's wording changes.
"""

import os
import shutil

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "sample_resume.txt")
TARGET = os.path.join(HERE, "..", "client", "public", "sample-resume.pdf")
JOB_SOURCE = os.path.join(HERE, "sample_job.txt")
JOB_TARGET = os.path.join(HERE, "..", "client", "public", "sample-job.txt")


def build() -> bytes:
    with open(SOURCE, encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    y = 60.0
    for index, line in enumerate(lines):
        if not line.strip():
            y += 6
            continue
        if index == 0:
            size, font = 20, "hebo"
        elif line.isupper():
            size, font = 11.5, "hebo"
        else:
            size, font = 10, "helv"
        page.insert_text((54, y), line, fontsize=size, fontname=font)
        y += size + 5
    doc.set_metadata({"title": "Sample resume (fictional)", "author": "RAGsToRiches demo"})
    data = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return data


if __name__ == "__main__":
    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    with open(TARGET, "wb") as handle:
        handle.write(build())
    shutil.copyfile(JOB_SOURCE, JOB_TARGET)
    print(f"wrote {os.path.relpath(TARGET)} and {os.path.relpath(JOB_TARGET)}")
