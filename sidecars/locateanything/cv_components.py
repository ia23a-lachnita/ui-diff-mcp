from __future__ import annotations

from typing import Any

import cv2
import numpy as np
from PIL import Image


def _box_area(box: tuple[int, int, int, int]) -> int:
    x, y, w, h = box
    return max(0, w) * max(0, h)


def detect_cv_components(image: Image.Image, max_boxes: int = 200) -> list[dict[str, Any]]:
    rgb = np.array(image.convert("RGB"))
    height, width = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 40, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _hierarchy = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    image_area = width * height
    boxes: list[tuple[int, int, int, int]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = _box_area((x, y, w, h))
        if area < 64:
            continue
        if area / image_area > 0.8:
            continue
        if w < 4 or h < 4:
            continue
        boxes.append((x, y, w, h))

    boxes.sort(key=_box_area, reverse=True)
    elements: list[dict[str, Any]] = []
    for index, (x, y, w, h) in enumerate(boxes[:max_boxes]):
        elements.append({
            "queryId": "cv_components",
            "label": f"cv-component-{index}",
            "box": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
            "rawBox1000": [
                int(round(x / width * 1000)),
                int(round(y / height * 1000)),
                int(round(w / width * 1000)),
                int(round(h / height * 1000)),
            ],
            "confidence": 0.55,
            "rawText": None,
        })
    return elements