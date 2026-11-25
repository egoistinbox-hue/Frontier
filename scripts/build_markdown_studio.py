#!/usr/bin/env python3
"""Embed repository Markdown files into the self-contained Markdown Studio viewer."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [
    ("docs/VegetationPortPlan.md", "VegetationPortPlan.md", "Vegetation port"),
    ("README.md", "README.md", "Repository root"),
]
TEMPLATE = ROOT / "demos/tree-generator/markdown-studio.template.html"
OUTPUT = ROOT / "demos/tree-generator/markdown-studio.html"

documents = []
for path, name, group in SOURCES:
    source = ROOT / path
    if source.exists():
        documents.append({
            "path": path,
            "name": name,
            "group": group,
            "content": source.read_text(encoding="utf-8"),
        })

payload = json.dumps(documents, ensure_ascii=False).replace("</", "<\\/")
html = TEMPLATE.read_text(encoding="utf-8").replace("__DOC_DATA__", payload)
OUTPUT.write_text(html, encoding="utf-8")
print(f"Built {OUTPUT.relative_to(ROOT)} with {len(documents)} documents")
