from __future__ import annotations

import os
from typing import Any

from PIL import Image


def yolo_detections_to_elements(detections: list[dict[str, Any]], image_width: int, image_height: int) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    for index, det in enumerate(detections):
        xyxy = det.get("xyxy")
        if not isinstance(xyxy, list) or len(xyxy) != 4:
            continue
        x1, y1, x2, y2 = [int(round(float(v))) for v in xyxy]
        w = max(0, x2 - x1)
        h = max(0, y2 - y1)
        if w < 2 or h < 2:
            continue
        label = str(det.get("class") or f"yolo-ui-{index}")
        elements.append({
            "queryId": "yolo_ui",
            "label": label,
            "box": {"x": x1, "y": y1, "width": w, "height": h},
            "rawBox1000": [
                int(round(x1 / image_width * 1000)),
                int(round(y1 / image_height * 1000)),
                int(round(w / image_width * 1000)),
                int(round(h / image_height * 1000)),
            ],
            "confidence": float(det.get("confidence", 0.75)),
            "rawText": label,
        })
    return elements


def detect_yolo_ui(image: Image.Image) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    model_path = os.environ.get("UI_DIFF_YOLO_UI_MODEL_PATH")
    if not model_path:
        return [], {
            "status": "not_configured",
            "count": 0,
            "model": "unset",
            "detail": "Set UI_DIFF_YOLO_UI_MODEL_PATH to enable local YOLO UI detection."
        }
    raise RuntimeError(f"YOLO runtime is not installed for model path: {model_path}")