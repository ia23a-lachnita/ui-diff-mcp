from __future__ import annotations

from typing import Any

from PIL import Image


def ocr_words_to_elements(words: list[dict[str, Any]], image_width: int, image_height: int) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    for index, word in enumerate(words):
        text = str(word.get("text", "")).strip()
        if not text:
            continue
        box = word["box"]
        x = int(box["x"])
        y = int(box["y"])
        w = int(box["width"])
        h = int(box["height"])
        if w < 2 or h < 2:
            continue
        elements.append({
            "queryId": "ocr_text",
            "label": text,
            "box": {"x": x, "y": y, "width": w, "height": h},
            "rawBox1000": [
                int(round(x / image_width * 1000)),
                int(round(y / image_height * 1000)),
                int(round(w / image_width * 1000)),
                int(round(h / image_height * 1000)),
            ],
            "confidence": float(word.get("confidence", 0.8)),
            "rawText": text,
        })
    return elements


def detect_ocr_text(image: Image.Image) -> tuple[list[dict[str, Any]], str]:
    # Keep this adapter explicit: production installs may choose PaddleOCR, EasyOCR,
    # or Tesseract. Tests use ocr_words_to_elements() directly.
    engine = "disabled"
    return [], engine