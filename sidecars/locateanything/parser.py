import re
from typing import Any


# The label group must never span a ref token: with a plain lazy group, a
# malformed answer whose first </ref> is not followed by <box> makes the lazy
# group expand PAST the inner </ref>, leaking raw model text into labels.
BOX_PATTERN = re.compile(
    r"(?:<ref>(?P<label>(?:(?!</?ref>).)*?)</ref>)?\s*<box><(?P<x1>-?\d+)><(?P<y1>-?\d+)><(?P<x2>-?\d+)><(?P<y2>-?\d+)></box>",
    re.DOTALL,
)

_REF_TOKEN = re.compile(r"</?ref>")
_BOX_TOKEN = re.compile(r"</?box>")
_COORD_TOKEN = re.compile(r"<-?\d+(?:\s*,\s*-?\d+)*>")


def _sanitize_label(raw_label: str) -> str:
    label = _REF_TOKEN.sub("", raw_label)
    label = _BOX_TOKEN.sub("", label)
    label = _COORD_TOKEN.sub("", label)
    return re.sub(r"\s+", " ", label).strip()


def _pixel_box(raw_box: list[int], image_width: int, image_height: int) -> dict[str, float]:
    x1, y1, x2, y2 = raw_box
    left = x1 / 1000 * image_width
    top = y1 / 1000 * image_height
    right = x2 / 1000 * image_width
    bottom = y2 / 1000 * image_height
    return {
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
    }


def parse_elements(
    *,
    query_id: str,
    answer: str,
    image_width: int,
    image_height: int,
    max_boxes: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    elements: list[dict[str, Any]] = []
    warnings: list[str] = []

    matches = list(BOX_PATTERN.finditer(answer))
    if len(matches) > max_boxes:
        warnings.append(
            f"query {query_id} returned more than maxBoxesPerQuery={max_boxes}; extra boxes were ignored"
        )

    for match in matches[:max_boxes]:
        raw_box = [
            int(match.group("x1")),
            int(match.group("y1")),
            int(match.group("x2")),
            int(match.group("y2")),
        ]
        raw_text = match.group(0)

        if any(coord < 0 or coord > 1000 for coord in raw_box):
            warnings.append(f"query {query_id} skipped out of normalized bounds box {raw_box}")
            continue

        x1, y1, x2, y2 = raw_box
        if x2 <= x1 or y2 <= y1:
            warnings.append(f"query {query_id} skipped invalid coordinate order box {raw_box}")
            continue

        box = _pixel_box(raw_box, image_width, image_height)
        if (
            box["x"] < -0.5
            or box["y"] < -0.5
            or box["x"] + box["width"] > image_width + 0.5
            or box["y"] + box["height"] > image_height + 0.5
        ):
            warnings.append(f"query {query_id} skipped out of image bounds box {raw_box}")
            continue

        label = _sanitize_label(match.group("label") or "") or query_id
        elements.append({
            "queryId": query_id,
            "label": label,
            "box": box,
            "rawBox1000": raw_box,
            "confidence": 1.0,
            "rawText": raw_text,
        })

    return elements, warnings
