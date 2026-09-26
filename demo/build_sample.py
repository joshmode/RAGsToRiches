"""Render demo/sample_resume.txt to client/public/sample-resume.pdf.

    python demo/build_sample.py

The PDF is committed so the client can serve it. Re-run this after editing the
text, and update demo/replay.json if a bullet's wording changes.
"""

import os

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "sample_resume.txt")
TARGET = os.path.join(HERE, "..", "client", "public", "sample-resume.pdf")


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
    print(f"wrote {os.path.relpath(TARGET)}")
