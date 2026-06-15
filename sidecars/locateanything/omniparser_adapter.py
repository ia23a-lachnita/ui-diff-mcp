from __future__ import annotations

import os
from typing import Any

from PIL import Image


OMNIPARSER_ICON_DETECT_LICENSE = "AGPL-3.0"


def omniparser_items_to_elements(items: list[dict[str, Any]], image_width: int, image_height: int) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        bbox = item.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            continue
        x1, y1, x2, y2 = [int(round(float(v))) for v in bbox]
        w = max(0, x2 - x1)
        h = max(0, y2 - y1)
        if w < 2 or h < 2:
            continue
        label = str(item.get("content") or item.get("type") or f"omniparser-{index}").strip()
        elements.append({
            "queryId": "omniparser",
            "label": label,
            "box": {"x": x1, "y": y1, "width": w, "height": h},
            "rawBox1000": [
                int(round(x1 / image_width * 1000)),
                int(round(y1 / image_height * 1000)),
                int(round(w / image_width * 1000)),
                int(round(h / image_height * 1000)),
            ],
            "confidence": float(item.get("confidence", 0.75)),
            "rawText": label,
        })
    return elements


def detect_omniparser(image: Image.Image) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if os.environ.get("UI_DIFF_ENABLE_OMNIPARSER") != "1":
        return [], {
            "status": "not_configured",
            "count": 0,
            "model": "microsoft/OmniParser",
            "license": OMNIPARSER_ICON_DETECT_LICENSE,
            "detail": "Set UI_DIFF_ENABLE_OMNIPARSER=1 and install OmniParser dependencies to enable."
        }
    raise RuntimeError("OmniParser runtime is not installed in this repository yet")