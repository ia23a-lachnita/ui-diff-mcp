# Screen Parser Locator Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current LocateAnything-only target discovery path with a measured, multi-lane screen parser that can pass Calorix bounded and full live gates without weak locator coverage.

**Architecture:** Keep the existing TypeScript MCP and report pipeline, but generalize the locator sidecar from "LocateAnything worker" to "screen parser service." The service returns the same element schema but may combine OmniParser-style UI parsing, YOLO UI-element detection, OCR boxes, and deterministic CV components. TypeScript owns validation, per-image coverage scoring, artifact/report contracts, pairing, and release gates.

**Tech Stack:** Node.js 22, TypeScript, Zod, Sharp, Vitest, Python FastAPI sidecar, OpenCV, optional OmniParser/YOLO/ONNX Runtime, optional OCR engine, existing NVIDIA/OpenRouter free-first auditor/reviewer adapters.

---

## Current Blocker

The latest fresh live gate run at `7ab7733` blocked release:

- `verify:calorix-live`: failed
- `locatorCoverageStatus`: `weak`
- `visualClassificationStatus`: `incomplete`
- Expected elements: `48`
- Actual elements: `1`
- Calorix full audit: skipped because bounded smoke already exposed the same root cause

The failure is not a test weakness. The current tests are correctly rejecting a bad target-discovery result.

## Research Summary

### LocateAnything

LocateAnything is a strong vision-language grounding model, but the project used it as a broad detector by issuing category prompts over dense full-screen UI images. That is not the same as running a UI-specific screen parser. The live Calorix result shows this mismatch: it returned useful boxes for the mockup and almost none for the actual app screenshot.

Decision: keep LocateAnything as one optional grounding lane for explicit queried targets, but do not let it be the only production target-discovery lane.

### OmniParser / OmniParser V2

Microsoft OmniParser is designed for parsing UI screenshots into structured elements. Its public docs and model card describe a combination of a finetuned YOLOv8 interactable detector, OCR, and icon captioning. OmniParser V2 reports better small-interactable detection and lower latency than v1.

Decision: add an OmniParser-compatible lane as the preferred parser for interactable/icon/text regions when its dependencies and license are acceptable. Do not hard-vendor model weights into this repo. Treat it as an external sidecar capability that reports its license and model metadata in `/health`.

License note: the OmniParser Hugging Face card states the icon detector model is AGPL while icon caption models are MIT. The plan must support this lane only when explicitly installed/enabled; production release must record whether AGPL components are active.

### YOLO UI-Element Detection

Research on GUI element detection consistently treats this as object detection, and recent work evaluates YOLO families on VINS/Rico-style UI screenshots. A unified Rico + WebUI YOLO-format dataset exists with classes such as Button, Text, Image, Icon, Input, Link, Checkbox, Toggle, Toolbar, Navigation, Modal, and Tab.

Decision: add a YOLO lane behind a local model path (`UI_DIFF_YOLO_UI_MODEL_PATH`). This is the fastest exact-box lane when a trained model is available. It is not enough alone because it needs OCR for text content and it may miss non-interactive visual regions.

### UIED-Style Deterministic CV + OCR

UIED combines text detection, CV component detection, classification, and merging. Its strength is inspectability and customizability: it can find boxes even when a model misses the screen. Its weakness is that classic CV boxes can over-split or merge visual regions.

Decision: add a deterministic CV/OCR lane that always runs in the sidecar. This lane is the production safety net for text boxes, cards, separators, chart/ring regions, and visible components. It must be generated automatically; no user-authored ROI or anchor config is allowed.

### SAM / SAM2

SAM/SAM2 is useful for segmentation, but it is not a UI element classifier and automatic masks are not directly a target map. It can help refine masks after a detector proposes boxes, but it should not be the first implementation path for the release blocker.

Decision: do not add SAM in this plan. Record it as a later mask-refinement candidate after the box-level parser passes live gates.

## Recommended Locator Architecture

Use a sidecar v2 parser with independent lanes:

1. `ocr_text`: text detection/recognition boxes.
2. `cv_components`: deterministic OpenCV boxes for non-text regions.
3. `omniparser`: optional OmniParser/OmniParser V2 boxes and icon labels.
4. `yolo_ui`: optional UI-element YOLO boxes from a local model path.
5. `locateanything`: optional grounding boxes for prompts, no longer the only lane.

The sidecar returns one merged response:

```json
{
  "model": "screen-parser-v2",
  "image": { "width": 1206, "height": 2622 },
  "elements": [],
  "warnings": [],
  "metadata": {
    "lanes": {
      "ocr_text": { "status": "complete", "count": 37 },
      "cv_components": { "status": "complete", "count": 81 },
      "omniparser": { "status": "not_configured", "count": 0 },
      "yolo_ui": { "status": "not_configured", "count": 0 },
      "locateanything": { "status": "complete", "count": 5 }
    }
  }
}
```

TypeScript then:

- validates all boxes,
- rejects useless giant boxes,
- runs class-aware non-maximum suppression and hierarchy-aware dedupe,
- scores expected and actual images separately,
- merges duplicates,
- writes target-map artifacts,
- fails live gates when either image has weak discovery.

## What Not To Do

- Do not relax the Calorix gate.
- Do not mark `actualElements: 1` as acceptable.
- Do not add user-authored target maps, ROI maps, ignore masks, anchor dumps, or Calorix-only manual config.
- Do not make SAM/SAM2 the first release-blocker fix.
- Do not make paid cloud models the default locator solution.
- Do not remove LocateAnything immediately; demote it to one lane so existing setup and tests keep working.

## Research Sources

- Microsoft OmniParser GitHub: https://github.com/microsoft/omniparser
- OmniParser V2 article: https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/
- OmniParser Hugging Face model card: https://huggingface.co/microsoft/OmniParser
- OmniParser paper: https://arxiv.org/html/2408.00203v1
- NVIDIA LocateAnything: https://research.nvidia.com/labs/lpr/locate-anything/
- LocateAnything model card: https://huggingface.co/nvidia/LocateAnything-3B
- UIED GitHub: https://github.com/MulongXie/UIED
- GUI Element Detection Using SOTA YOLO Deep Learning Models: https://arxiv.org/html/2408.03507v1
- Rico dataset: https://www.interactionmining.org/archive/rico
- Unified Rico + WebUI YOLO dataset: https://zenodo.org/records/19195885
- Ultralytics export docs: https://docs.ultralytics.com/modes/export
- Tesseract.js OCR boxes: https://tesseract.projectnaptha.com/
- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR
- SAM2: https://ai.meta.com/research/sam2/

---

## File Structure

- Modify `src/schemas/core.ts`: add per-image locator metadata and lane metadata.
- Modify `src/locator/locateanything-client.ts`: accept optional `metadata` from sidecar without breaking old responses.
- Modify `src/locator/element-map.ts`: add box-quality filters and per-image coverage scoring.
- Create `src/locator/nms.ts`: lane-aware non-maximum suppression for overlapping parser boxes.
- Modify `src/pipeline/run-ui-diff.ts`: compute expected and actual locator coverage separately, write diagnostics, and call sidecar v2.
- Create `src/locator/coverage.ts`: coverage scoring and diagnostics helpers.
- Create `src/locator/diagnostics.ts`: target-map artifact data builder.
- Modify `src/images/artifacts.ts`: write target-map overlay artifacts.
- Modify `sidecars/locateanything/server.py`: rename internally to a multi-lane parser while preserving endpoint path.
- Create `sidecars/locateanything/cv_components.py`: OpenCV component detection.
- Create `sidecars/locateanything/ocr_text.py`: OCR lane adapter with deterministic no-OCR behavior in tests.
- Create `sidecars/locateanything/omniparser_adapter.py`: optional OmniParser lane adapter.
- Create `sidecars/locateanything/yolo_adapter.py`: optional YOLO lane adapter.
- Modify `sidecars/locateanything/README.md`: document sidecar v2 lanes and license gates.
- Modify `scripts/start-locateanything-sidecar.ps1`: keep existing command, add parser-v2 env examples.
- Modify `tests/fixtures/mock-sidecar.ts`: support lane metadata and per-image weak/complete cases.
- Create/modify unit tests under `tests/unit`.
- Modify live tests under `tests/live`.
- Modify `docs/release/production-readiness-checklist.md`.
- Modify `docs/implementation-status.md`.

---

## Task 1: Add Per-Image Locator Diagnostics And Strict Coverage Scoring

**Files:**
- Modify: `src/schemas/core.ts`
- Create: `src/locator/coverage.ts`
- Test: `tests/unit/locator-coverage.test.ts`

- [ ] **Step 1: Add failing tests for per-image scoring**

Create `tests/unit/locator-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { UiElement } from "../../src/schemas/core.js";
import { computeImageLocatorCoverage, isUsefulLocatorBox } from "../../src/locator/coverage.js";

function el(id: string, queryId: string, x: number, y: number, width: number, height: number): UiElement {
  return {
    id,
    label: id,
    type: "unknown",
    queryId,
    box: { x, y, width, height },
    normalizedBox: { x: x / 1000, y: y / 2000, width: width / 1000, height: height / 2000 },
    confidence: 0.9,
    source: "locator",
    childIds: []
  };
}

describe("computeImageLocatorCoverage", () => {
  it("marks coverage complete only when enough query ids have useful hits", () => {
    const result = computeImageLocatorCoverage({
      elements: [
        el("text", "text_labels", 10, 10, 100, 30),
        el("button", "buttons", 20, 100, 100, 50),
        el("icon", "icons", 40, 190, 40, 40),
        el("card", "cards_panels_containers", 0, 300, 400, 200),
        el("nav", "tab_bar_nav_elements", 0, 1800, 1000, 150),
        el("chart", "charts_indicators", 200, 600, 300, 300)
      ],
      promptCount: 8,
      imageSize: { width: 1000, height: 2000 },
      minQueryCoverageRatio: 0.75,
      minElementCount: 12
    });

    expect(result.status).toBe("weak");
    expect(result.reasons).toContain("element_count_below_minimum");
  });

  it("rejects a single full-screen box as useful coverage", () => {
    const box = el("giant", "text_labels", 0, 0, 1000, 2000);
    expect(isUsefulLocatorBox(box, { width: 1000, height: 2000 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run tests/unit/locator-coverage.test.ts
```

Expected: FAIL because `src/locator/coverage.ts` does not exist.

- [ ] **Step 3: Implement coverage helper**

Create `src/locator/coverage.ts`:

```ts
import type { LocatorCoverageStatus, UiElement } from "../schemas/core.js";

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageLocatorCoverageInput {
  elements: UiElement[];
  promptCount: number;
  imageSize: ImageSize;
  minQueryCoverageRatio?: number;
  minElementCount?: number;
}

export interface ImageLocatorCoverage {
  status: LocatorCoverageStatus;
  promptCount: number;
  usefulElementCount: number;
  queryCounts: Record<string, number>;
  queryCoverageRatio: number;
  rejectedElementCount: number;
  reasons: string[];
}

export function isUsefulLocatorBox(element: UiElement, imageSize: ImageSize): boolean {
  const imageArea = imageSize.width * imageSize.height;
  const boxArea = element.box.width * element.box.height;
  if (boxArea <= 0) return false;
  if (boxArea / imageArea > 0.8) return false;
  if (element.box.width < 3 || element.box.height < 3) return false;
  return true;
}

export function computeImageLocatorCoverage(input: ImageLocatorCoverageInput): ImageLocatorCoverage {
  const minQueryCoverageRatio = input.minQueryCoverageRatio ?? 0.75;
  const minElementCount = input.minElementCount ?? 12;
  const useful = input.elements.filter(e => isUsefulLocatorBox(e, input.imageSize));
  const queryCounts: Record<string, number> = {};

  for (const element of useful) {
    if (element.queryId) {
      queryCounts[element.queryId] = (queryCounts[element.queryId] ?? 0) + 1;
    }
  }

  const queryCoverageRatio = input.promptCount === 0
    ? 0
    : Object.keys(queryCounts).length / input.promptCount;
  const reasons: string[] = [];

  if (input.promptCount === 0) reasons.push("no_locator_prompts");
  if (queryCoverageRatio < minQueryCoverageRatio) reasons.push("query_coverage_below_threshold");
  if (useful.length < minElementCount) reasons.push("element_count_below_minimum");
  if (useful.length === 0 && input.elements.length > 0) reasons.push("all_elements_rejected_as_low_quality");

  let status: LocatorCoverageStatus = "complete";
  if (input.promptCount === 0) status = "not_run";
  else if (useful.length === 0) status = "failed";
  else if (reasons.length > 0) status = "weak";

  return {
    status,
    promptCount: input.promptCount,
    usefulElementCount: useful.length,
    queryCounts,
    queryCoverageRatio,
    rejectedElementCount: input.elements.length - useful.length,
    reasons
  };
}
```

- [ ] **Step 4: Extend schema for per-image metadata**

Modify `src/schemas/core.ts` so `LocatorMetadataSchema` becomes:

```ts
export const ImageLocatorCoverageSchema = z.object({
  status: LocatorCoverageStatusSchema,
  promptCount: z.number().int().nonnegative(),
  usefulElementCount: z.number().int().nonnegative(),
  queryCounts: z.record(z.string(), z.number().int().nonnegative()),
  queryCoverageRatio: z.number().finite().min(0).max(1),
  rejectedElementCount: z.number().int().nonnegative(),
  reasons: z.array(z.string()).default([])
});

export const LocatorLaneMetadataSchema = z.object({
  status: z.enum(["complete", "failed", "not_configured", "skipped"]),
  count: z.number().int().nonnegative(),
  detail: z.string().optional(),
  model: z.string().optional(),
  license: z.string().optional()
});

export const LocatorMetadataSchema = z.object({
  promptCount: z.number().int().nonnegative(),
  queryCounts: z.record(z.string(), z.number().int().nonnegative()),
  expected: ImageLocatorCoverageSchema.optional(),
  actual: ImageLocatorCoverageSchema.optional(),
  lanes: z.record(z.string(), LocatorLaneMetadataSchema).optional()
});
```

- [ ] **Step 5: Run focused test**

Run:

```powershell
npx vitest run tests/unit/locator-coverage.test.ts tests/unit/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/schemas/core.ts src/locator/coverage.ts tests/unit/locator-coverage.test.ts docs/implementation-status.md
git commit -m "feat: score locator coverage per image"
git push origin master
```

---

## Task 2: Add Sidecar V2 Metadata Without Breaking Existing LocateAnything Responses

**Files:**
- Modify: `src/locator/locateanything-client.ts`
- Modify: `tests/unit/locateanything-client.test.ts`

- [ ] **Step 1: Add failing parser test for sidecar metadata**

In `tests/unit/locateanything-client.test.ts`, add:

```ts
it("accepts sidecar v2 lane metadata", async () => {
  const body = JSON.stringify({
    model: "screen-parser-v2",
    image: { width: 100, height: 200 },
    elements: [],
    warnings: [],
    metadata: {
      lanes: {
        ocr_text: { status: "complete", count: 12, model: "tesseract" },
        omniparser: { status: "not_configured", count: 0, license: "AGPL-3.0" }
      }
    }
  });

  const { server: s, port } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
  server = s;

  const result = await locateUiElements({
    endpoint: `http://127.0.0.1:${port}`,
    request: BASE_REQUEST,
    timeoutMs: 5000
  });

  expect(result.model).toBe("screen-parser-v2");
  expect(result.metadata?.lanes?.ocr_text?.count).toBe(12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run tests/unit/locateanything-client.test.ts
```

Expected: FAIL because response metadata is not in the schema.

- [ ] **Step 3: Extend response schema**

Modify `src/locator/locateanything-client.ts`:

```ts
const LaneMetadataSchema = z.object({
  status: z.enum(["complete", "failed", "not_configured", "skipped"]),
  count: z.number().int().nonnegative(),
  detail: z.string().optional(),
  model: z.string().optional(),
  license: z.string().optional()
});

export const LocateAnythingResponseSchema = z.object({
  model: z.string().min(1),
  image: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  elements: z.array(LocateAnythingElementSchema),
  warnings: z.array(z.string()).default([]),
  metadata: z.object({
    lanes: z.record(z.string(), LaneMetadataSchema).optional()
  }).optional()
});
```

- [ ] **Step 4: Run focused test**

Run:

```powershell
npx vitest run tests/unit/locateanything-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/locator/locateanything-client.ts tests/unit/locateanything-client.test.ts docs/implementation-status.md
git commit -m "feat: accept screen parser sidecar metadata"
git push origin master
```

---

## Task 3: Add Deterministic CV Component Lane In The Python Sidecar

**Files:**
- Create: `sidecars/locateanything/cv_components.py`
- Modify: `sidecars/locateanything/server.py`
- Test: `sidecars/locateanything/test_parser.py`
- Modify: `sidecars/locateanything/requirements.txt`

- [ ] **Step 1: Add failing Python test for CV components**

Append to `sidecars/locateanything/test_parser.py`:

```py
class CvComponentLaneTests(unittest.TestCase):
    def test_detects_simple_card_and_button_regions(self):
        from PIL import Image, ImageDraw
        from sidecars.locateanything.cv_components import detect_cv_components

        image = Image.new("RGB", (240, 480), "#111111")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((20, 80, 220, 200), radius=16, fill="#222222", outline="#444444")
        draw.rounded_rectangle((40, 140, 160, 180), radius=10, fill="#77aa44")

        elements = detect_cv_components(image, max_boxes=20)

        self.assertGreaterEqual(len(elements), 2)
        self.assertTrue(any(el["queryId"] == "cv_components" for el in elements))
        self.assertTrue(all(el["confidence"] >= 0.4 for el in elements))
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -m unittest sidecars.locateanything.test_parser.CvComponentLaneTests
```

Expected: FAIL because `cv_components.py` does not exist.

- [ ] **Step 3: Add OpenCV dependency**

Modify `sidecars/locateanything/requirements.txt` to include:

```text
opencv-python-headless>=4.10,<5
numpy>=1.26,<3
```

- [ ] **Step 4: Implement CV component lane**

Create `sidecars/locateanything/cv_components.py`:

```py
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
    contours, _hierarchy = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

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
```

- [ ] **Step 5: Wire lane into sidecar**

Modify `sidecars/locateanything/server.py` so `locate_ui_elements()` always runs CV components before LocateAnything:

```py
from sidecars.locateanything.cv_components import detect_cv_components
```

Inside `locate_ui_elements()` after image size:

```py
    lane_metadata: dict[str, dict[str, Any]] = {}

    try:
        cv_elements = detect_cv_components(image, max_boxes=min(request.maxBoxesPerQuery, 200))
        all_elements.extend(cv_elements)
        lane_metadata["cv_components"] = {"status": "complete", "count": len(cv_elements), "model": "opencv"}
    except Exception as exc:
        warnings.append(f"cv_components lane failed: {type(exc).__name__}: {exc}")
        lane_metadata["cv_components"] = {"status": "failed", "count": 0, "detail": str(exc), "model": "opencv"}
```

And add `metadata` to the response:

```py
        "metadata": {"lanes": lane_metadata},
```

- [ ] **Step 6: Run sidecar tests**

Run:

```powershell
python -m unittest sidecars.locateanything.test_parser
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add sidecars/locateanything/cv_components.py sidecars/locateanything/server.py sidecars/locateanything/test_parser.py sidecars/locateanything/requirements.txt docs/implementation-status.md
git commit -m "feat: add deterministic cv locator lane"
git push origin master
```

---

## Task 4: Add OCR Text Lane

**Files:**
- Create: `sidecars/locateanything/ocr_text.py`
- Modify: `sidecars/locateanything/server.py`
- Test: `sidecars/locateanything/test_parser.py`
- Modify: `sidecars/locateanything/README.md`

- [ ] **Step 1: Add failing OCR adapter test using injected fake OCR**

Append to `sidecars/locateanything/test_parser.py`:

```py
class OcrTextLaneTests(unittest.TestCase):
    def test_converts_ocr_words_to_locator_elements(self):
        from sidecars.locateanything.ocr_text import ocr_words_to_elements

        words = [
            {"text": "Today", "box": {"x": 10, "y": 20, "width": 80, "height": 24}, "confidence": 0.95},
            {"text": "", "box": {"x": 0, "y": 0, "width": 10, "height": 10}, "confidence": 0.99},
        ]

        elements = ocr_words_to_elements(words, image_width=200, image_height=400)

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["queryId"], "ocr_text")
        self.assertEqual(elements[0]["label"], "Today")
        self.assertEqual(elements[0]["box"]["width"], 80)
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -m unittest sidecars.locateanything.test_parser.OcrTextLaneTests
```

Expected: FAIL because `ocr_text.py` does not exist.

- [ ] **Step 3: Implement OCR adapter boundary**

Create `sidecars/locateanything/ocr_text.py`:

```py
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
```

- [ ] **Step 4: Wire OCR lane into sidecar**

Modify `sidecars/locateanything/server.py`:

```py
from sidecars.locateanything.ocr_text import detect_ocr_text
```

After CV lane:

```py
    try:
        ocr_elements, ocr_engine = detect_ocr_text(image)
        all_elements.extend(ocr_elements)
        lane_metadata["ocr_text"] = {"status": "complete", "count": len(ocr_elements), "model": ocr_engine}
    except Exception as exc:
        warnings.append(f"ocr_text lane failed: {type(exc).__name__}: {exc}")
        lane_metadata["ocr_text"] = {"status": "failed", "count": 0, "detail": str(exc)}
```

- [ ] **Step 5: Document OCR engine decision**

Add to `sidecars/locateanything/README.md`:

```md
### OCR lane

The sidecar v2 contract includes an `ocr_text` lane. The first implementation ships the adapter boundary and records `model: "disabled"` unless an OCR engine is installed. Production candidates:

- Tesseract/Tesseract.js: simplest local deployment and word boxes.
- PaddleOCR: stronger OCR and document parsing, heavier Python dependency.

The release gate must pass without user-authored OCR config. If OCR is enabled, the report records the engine in `locatorMetadata.lanes.ocr_text.model`.
```

- [ ] **Step 6: Run sidecar tests**

Run:

```powershell
python -m unittest sidecars.locateanything.test_parser
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add sidecars/locateanything/ocr_text.py sidecars/locateanything/server.py sidecars/locateanything/test_parser.py sidecars/locateanything/README.md docs/implementation-status.md
git commit -m "feat: add ocr text locator lane boundary"
git push origin master
```

---

## Task 5: Add Optional OmniParser Lane

**Files:**
- Create: `sidecars/locateanything/omniparser_adapter.py`
- Modify: `sidecars/locateanything/server.py`
- Test: `sidecars/locateanything/test_parser.py`
- Modify: `sidecars/locateanything/README.md`

- [ ] **Step 1: Add tests for adapter normalization and license metadata**

Append to `sidecars/locateanything/test_parser.py`:

```py
class OmniParserAdapterTests(unittest.TestCase):
    def test_normalizes_omniparser_boxes(self):
        from sidecars.locateanything.omniparser_adapter import omniparser_items_to_elements

        items = [
            {"type": "icon", "content": "settings", "bbox": [10, 20, 30, 40], "confidence": 0.88},
            {"type": "text", "content": "Calories", "bbox": [50, 60, 140, 82], "confidence": 0.91},
        ]

        elements = omniparser_items_to_elements(items, image_width=200, image_height=400)

        self.assertEqual(len(elements), 2)
        self.assertEqual(elements[0]["queryId"], "omniparser")
        self.assertEqual(elements[0]["label"], "settings")
        self.assertEqual(elements[0]["box"], {"x": 10, "y": 20, "width": 20, "height": 20})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -m unittest sidecars.locateanything.test_parser.OmniParserAdapterTests
```

Expected: FAIL because adapter does not exist.

- [ ] **Step 3: Implement optional adapter**

Create `sidecars/locateanything/omniparser_adapter.py`:

```py
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
```

- [ ] **Step 4: Wire optional lane into sidecar**

Modify `sidecars/locateanything/server.py`:

```py
from sidecars.locateanything.omniparser_adapter import detect_omniparser
```

After OCR lane:

```py
    try:
        omni_elements, omni_meta = detect_omniparser(image)
        all_elements.extend(omni_elements)
        lane_metadata["omniparser"] = omni_meta
    except Exception as exc:
        warnings.append(f"omniparser lane failed: {type(exc).__name__}: {exc}")
        lane_metadata["omniparser"] = {
            "status": "failed",
            "count": 0,
            "detail": str(exc),
            "model": "microsoft/OmniParser",
            "license": "AGPL-3.0"
        }
```

- [ ] **Step 5: Document OmniParser lane and license gate**

Add to `sidecars/locateanything/README.md`:

```md
### OmniParser lane

`UI_DIFF_ENABLE_OMNIPARSER=1` enables the optional OmniParser lane when its Python dependencies and model weights are installed outside this repository.

The OmniParser model card states the icon detection model is AGPL-licensed. This repo must not vendor those weights. The sidecar reports `license: "AGPL-3.0"` in `/v1/locate-ui-elements` metadata whenever this lane is configured or fails, so release reports can record the active license surface.
```

- [ ] **Step 6: Run sidecar tests**

Run:

```powershell
python -m unittest sidecars.locateanything.test_parser
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add sidecars/locateanything/omniparser_adapter.py sidecars/locateanything/server.py sidecars/locateanything/test_parser.py sidecars/locateanything/README.md docs/implementation-status.md
git commit -m "feat: add optional omniparser locator lane"
git push origin master
```

---

## Task 6: Add Optional YOLO UI-Element Lane

**Files:**
- Create: `sidecars/locateanything/yolo_adapter.py`
- Modify: `sidecars/locateanything/server.py`
- Test: `sidecars/locateanything/test_parser.py`
- Modify: `sidecars/locateanything/README.md`

- [ ] **Step 1: Add tests for YOLO result normalization**

Append to `sidecars/locateanything/test_parser.py`:

```py
class YoloAdapterTests(unittest.TestCase):
    def test_normalizes_yolo_detections(self):
        from sidecars.locateanything.yolo_adapter import yolo_detections_to_elements

        detections = [
            {"class": "Button", "confidence": 0.9, "xyxy": [10, 20, 110, 60]},
            {"class": "Icon", "confidence": 0.7, "xyxy": [150, 20, 180, 50]},
        ]

        elements = yolo_detections_to_elements(detections, image_width=200, image_height=400)

        self.assertEqual(len(elements), 2)
        self.assertEqual(elements[0]["queryId"], "yolo_ui")
        self.assertEqual(elements[0]["label"], "Button")
        self.assertEqual(elements[0]["box"]["height"], 40)
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -m unittest sidecars.locateanything.test_parser.YoloAdapterTests
```

Expected: FAIL because adapter does not exist.

- [ ] **Step 3: Implement optional YOLO adapter boundary**

Create `sidecars/locateanything/yolo_adapter.py`:

```py
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
```

- [ ] **Step 4: Wire YOLO lane into sidecar**

Modify `sidecars/locateanything/server.py`:

```py
from sidecars.locateanything.yolo_adapter import detect_yolo_ui
```

After OmniParser lane:

```py
    try:
        yolo_elements, yolo_meta = detect_yolo_ui(image)
        all_elements.extend(yolo_elements)
        lane_metadata["yolo_ui"] = yolo_meta
    except Exception as exc:
        warnings.append(f"yolo_ui lane failed: {type(exc).__name__}: {exc}")
        lane_metadata["yolo_ui"] = {"status": "failed", "count": 0, "detail": str(exc), "model": "local-yolo-ui"}
```

- [ ] **Step 5: Document YOLO lane**

Add to `sidecars/locateanything/README.md`:

```md
### YOLO UI lane

`UI_DIFF_YOLO_UI_MODEL_PATH` points to a local UI-element detector model. Candidate training data includes Rico, VINS, WebUI, and the unified Rico+WebUI YOLO-format dataset. The first production goal is not to train a new model inside this repo; it is to make the sidecar contract accept a local detector and record its model path hash/metadata in reports.
```

- [ ] **Step 6: Run sidecar tests**

Run:

```powershell
python -m unittest sidecars.locateanything.test_parser
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add sidecars/locateanything/yolo_adapter.py sidecars/locateanything/server.py sidecars/locateanything/test_parser.py sidecars/locateanything/README.md docs/implementation-status.md
git commit -m "feat: add optional yolo ui locator lane"
git push origin master
```

---

## Task 7: Merge Multi-Lane Elements With NMS And Write Target-Map Artifacts

**Files:**
- Modify: `src/locator/element-map.ts`
- Create: `src/locator/nms.ts`
- Create: `src/locator/diagnostics.ts`
- Modify: `src/images/artifacts.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/element-map.test.ts`
- Test: `tests/unit/locator-nms.test.ts`
- Test: `tests/unit/locator-diagnostics.test.ts`

- [ ] **Step 1: Add tests for lane-aware merge**

Add to `tests/unit/element-map.test.ts`:

```ts
it("preserves source lane in queryId while merging overlapping boxes", () => {
  const els = buildElementMap([
    makeEl("ocr_text", "Calories", 10, 20, 100, 24),
    makeEl("yolo_ui", "Text", 12, 19, 98, 26)
  ], { width: 200, height: 400 });

  expect(els).toHaveLength(1);
  expect(els[0]?.queryId).toContain("ocr_text");
});
```

- [ ] **Step 2: Add NMS tests for duplicate parser boxes**

Create `tests/unit/locator-nms.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { UiElement } from "../../src/schemas/core.js";
import { suppressDuplicateElements } from "../../src/locator/nms.js";

function el(id: string, queryId: string, x: number, y: number, width: number, height: number, confidence: number): UiElement {
  return {
    id,
    label: id,
    type: "unknown",
    queryId,
    box: { x, y, width, height },
    normalizedBox: { x: x / 200, y: y / 400, width: width / 200, height: height / 400 },
    confidence,
    source: "locator",
    childIds: []
  };
}

describe("suppressDuplicateElements", () => {
  it("keeps the best overlapping box and preserves contributing lanes", () => {
    const result = suppressDuplicateElements([
      el("ocr", "ocr_text", 10, 20, 100, 40, 0.70),
      el("yolo", "yolo_ui", 12, 21, 98, 39, 0.95),
      el("icon", "icons", 150, 20, 24, 24, 0.80)
    ], { iouThreshold: 0.72 });

    expect(result).toHaveLength(2);
    expect(result[0]?.queryId).toContain("ocr_text");
    expect(result[0]?.queryId).toContain("yolo_ui");
    expect(result[0]?.confidence).toBe(0.95);
  });
});
```

- [ ] **Step 3: Add target-map diagnostic test**

Create `tests/unit/locator-diagnostics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTargetMapJson } from "../../src/locator/diagnostics.js";

describe("buildTargetMapJson", () => {
  it("serializes element ids, labels, boxes, and coverage", () => {
    const json = buildTargetMapJson({
      imageRole: "actual",
      coverage: {
        status: "weak",
        promptCount: 8,
        usefulElementCount: 1,
        queryCounts: { text_labels: 1 },
        queryCoverageRatio: 0.125,
        rejectedElementCount: 1,
        reasons: ["query_coverage_below_threshold"]
      },
      elements: []
    });

    expect(json.imageRole).toBe("actual");
    expect(json.coverage.status).toBe("weak");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```powershell
npx vitest run tests/unit/element-map.test.ts tests/unit/locator-nms.test.ts tests/unit/locator-diagnostics.test.ts
```

Expected: FAIL because diagnostics helper does not exist and merge behavior is not lane-aware.

- [ ] **Step 5: Implement NMS helper**

Create `src/locator/nms.ts`:

```ts
import type { UiElement } from "../schemas/core.js";
import { iou } from "../signals/geometry.js";

function mergeQueryIds(a?: string, b?: string): string | undefined {
  const parts = new Set<string>();
  for (const value of [a, b]) {
    if (!value) continue;
    for (const part of value.split("+")) parts.add(part);
  }
  return parts.size > 0 ? [...parts].sort().join("+") : undefined;
}

function mergeElement(primary: UiElement, duplicate: UiElement): UiElement {
  return {
    ...primary,
    confidence: Math.max(primary.confidence, duplicate.confidence),
    queryId: mergeQueryIds(primary.queryId, duplicate.queryId),
    label: primary.confidence >= duplicate.confidence ? primary.label : duplicate.label,
    text: primary.text ?? duplicate.text,
    source: "merged"
  };
}

export function suppressDuplicateElements(
  elements: UiElement[],
  options: { iouThreshold?: number } = {}
): UiElement[] {
  const iouThreshold = options.iouThreshold ?? 0.72;
  const sorted = [...elements].sort((a, b) => b.confidence - a.confidence);
  const kept: UiElement[] = [];

  for (const element of sorted) {
    const index = kept.findIndex(existing => iou(existing.box, element.box) >= iouThreshold);
    if (index === -1) {
      kept.push(element);
      continue;
    }
    kept[index] = mergeElement(kept[index]!, element);
  }

  return kept;
}
```

- [ ] **Step 6: Implement diagnostics helper**

Create `src/locator/diagnostics.ts`:

```ts
import type { UiElement } from "../schemas/core.js";
import type { ImageLocatorCoverage } from "./coverage.js";

export function buildTargetMapJson(input: {
  imageRole: "expected" | "actual";
  coverage: ImageLocatorCoverage;
  elements: UiElement[];
}) {
  return {
    imageRole: input.imageRole,
    coverage: input.coverage,
    elements: input.elements.map(e => ({
      id: e.id,
      label: e.label,
      type: e.type,
      queryId: e.queryId,
      source: e.source,
      confidence: e.confidence,
      box: e.box,
      text: e.text
    }))
  };
}
```

- [ ] **Step 7: Apply NMS and preserve lane provenance in element map**

Modify `src/locator/element-map.ts` so `buildElementMap()` calls `suppressDuplicateElements()` before returning. Remove any older merge behavior that drops `queryId` provenance. The resulting `queryId` must be a `+`-joined unique list of contributing lanes.

Use this import:

```ts
import { suppressDuplicateElements } from "./nms.js";
```

- [ ] **Step 8: Write target-map JSON artifacts in pipeline**

In `src/pipeline/run-ui-diff.ts`, after element maps and coverage are computed:

```ts
const expectedCoverage = computeImageLocatorCoverage({
  elements: expectedElements,
  promptCount: locatorQueries.length,
  imageSize: { width: expectedImg.width, height: expectedImg.height }
});
const actualCoverage = computeImageLocatorCoverage({
  elements: actualElements,
  promptCount: locatorQueries.length,
  imageSize: { width: actualImg.width, height: actualImg.height }
});
locatorCoverageStatus = expectedCoverage.status === "complete" && actualCoverage.status === "complete"
  ? "complete"
  : expectedCoverage.status === "failed" || actualCoverage.status === "failed"
    ? "failed"
    : "weak";
```

Then write JSON artifacts:

```ts
await writeJsonArtifact(path.join(artifactDir, "target-map-expected.json"), buildTargetMapJson({
  imageRole: "expected",
  coverage: expectedCoverage,
  elements: expectedElements
}));
await writeJsonArtifact(path.join(artifactDir, "target-map-actual.json"), buildTargetMapJson({
  imageRole: "actual",
  coverage: actualCoverage,
  elements: actualElements
}));
```

- [ ] **Step 9: Run focused tests**

Run:

```powershell
npx vitest run tests/unit/element-map.test.ts tests/unit/locator-nms.test.ts tests/unit/locator-diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add src/locator/element-map.ts src/locator/nms.ts src/locator/diagnostics.ts src/pipeline/run-ui-diff.ts tests/unit/element-map.test.ts tests/unit/locator-nms.test.ts tests/unit/locator-diagnostics.test.ts docs/implementation-status.md
git commit -m "feat: record lane-aware locator diagnostics"
git push origin master
```

---

## Task 8: Harden Live Gates For Parser Quality

**Files:**
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `tests/live/mcp-full.live.test.ts`
- Modify: `tests/helpers/sidecar-manager.ts`
- Modify: `docs/release/production-readiness-checklist.md`

- [ ] **Step 1: Add Calorix assertions for per-image coverage**

In both Calorix live tests, after parsing `report`:

```ts
expect(report.locatorMetadata?.expected?.status, "expected image locator coverage must be complete").toBe("complete");
expect(report.locatorMetadata?.actual?.status, "actual image locator coverage must be complete").toBe("complete");
expect(report.locatorMetadata?.actual?.usefulElementCount ?? 0, "actual useful elements must be sufficient").toBeGreaterThanOrEqual(12);
expect(report.locatorMetadata?.actual?.reasons ?? [], "actual locator coverage has weakness reasons").toEqual([]);
```

- [ ] **Step 2: Assert target-map artifacts exist**

Add:

```ts
expect(report.runArtifacts.some(a => a.role === "target_map_expected")).toBe(true);
expect(report.runArtifacts.some(a => a.role === "target_map_actual")).toBe(true);
```

- [ ] **Step 3: Increase foreground budget for live MCP tests**

Modify `tests/live/mcp-full.live.test.ts` and `tests/live/mcp-openrouter-free.live.test.ts`:

```ts
started = await startUiDiffMcpClient({ UI_DIFF_FOREGROUND_BUDGET_MS: "300000" });
```

- [ ] **Step 4: Warm the sidecar before foreground live runs**

In `tests/helpers/sidecar-manager.ts`, after `/health` returns ready, call a small sidecar request using an in-memory tiny PNG fixture only when `UI_DIFF_SIDECAR_WARMUP=1`.

Expected behavior:

- Warmup failure fails the live gate.
- Async Calorix gates continue to use `start_ui_diff_run`.

- [ ] **Step 5: Run deterministic test suite**

Run:

```powershell
npm run verify
npm run test:coverage
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add tests/live tests/helpers docs/release/production-readiness-checklist.md docs/implementation-status.md
git commit -m "test: harden live parser quality gates"
git push origin master
```

---

## Task 9: Run Candidate Parser Matrix On Calorix And Select Default

**Files:**
- Create: `scripts/benchmark-locator-lanes.ts`
- Modify: `docs/research/locator-lane-benchmark.md`
- Modify: `docs/implementation-status.md`

- [ ] **Step 1: Add benchmark script**

Create `scripts/benchmark-locator-lanes.ts` that:

- starts or uses sidecar at `LOCATEANYTHING_SIDECAR_URL`,
- sends expected and actual Calorix images,
- records sidecar lane metadata,
- records per-image coverage,
- writes `docs/research/locator-lane-benchmark.md`.

Script skeleton:

```ts
import fs from "node:fs/promises";

const expectedImagePath = process.env["UI_DIFF_LIVE_EXPECTED_IMAGE"];
const actualImagePath = process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"];
const sidecarUrl = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";

if (!expectedImagePath || !actualImagePath) {
  throw new Error("UI_DIFF_LIVE_EXPECTED_IMAGE and UI_DIFF_LIVE_ACTUAL_IMAGE are required");
}

// Use locateUiElements() and computeImageLocatorCoverage() after implementation.
await fs.writeFile("docs/research/locator-lane-benchmark.md", "# Locator Lane Benchmark\\n");
```

- [ ] **Step 2: Add npm script**

Modify `package.json`:

```json
"benchmark:locator": "tsx scripts/benchmark-locator-lanes.ts"
```

- [ ] **Step 3: Run benchmark with current sidecar**

Run:

```powershell
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-09-criterion-audit-validation.png"
npm run benchmark:locator
```

Expected: benchmark markdown is written with per-lane counts and coverage.

- [ ] **Step 4: Select default parser policy**

Update `docs/research/locator-lane-benchmark.md` with:

```md
## Default Parser Policy

Default enabled lanes:

1. `cv_components`
2. `ocr_text` when an OCR engine is installed
3. `locateanything`
4. `omniparser` only when explicitly enabled and license accepted
5. `yolo_ui` only when a local model path is configured

Release selection rule: Calorix bounded and full live gates must pass with this policy before tagging.
```

- [ ] **Step 5: Commit**

```powershell
git add package.json scripts/benchmark-locator-lanes.ts docs/research/locator-lane-benchmark.md docs/implementation-status.md
git commit -m "chore: add locator lane benchmark"
git push origin master
```

---

## Task 10: Final Release Gates

**Files:**
- Modify: `docs/release/2026-06-15-production-readiness-report.md`
- Modify: `docs/implementation-status.md`

- [ ] **Step 1: Run deterministic gates**

Run:

```powershell
npm run verify
npm run test:coverage
```

Expected: PASS.

- [ ] **Step 2: Run provider gates**

Run:

```powershell
npm run verify:nvidia-live
npm run verify:openrouter-free-live
npm run verify:mcp-live
```

Expected:

- NVIDIA: PASS
- OpenRouter free: PASS
- Default MCP live: PASS on first attempt with 300000 ms foreground budget and sidecar warmup

- [ ] **Step 3: Run Calorix gates**

Run:

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-09-criterion-audit-validation.png"
npm run verify:calorix-live

$env:RUN_CALORIX_FULL_LIVE="1"
npm run verify:calorix-full-live
```

Expected:

- both pass,
- `locatorCoverageStatus === "complete"`,
- `locatorMetadata.expected.status === "complete"`,
- `locatorMetadata.actual.status === "complete"`,
- `visualClassificationStatus === "complete"`,
- `auditLimited === false` for full live,
- report contains `target_map_expected` and `target_map_actual` artifacts.

- [ ] **Step 4: Update release report**

Modify `docs/release/2026-06-15-production-readiness-report.md` with the fresh run results and either:

```md
**READY for production release tag at HEAD `<commit>`**
```

or keep:

```md
**NOT READY for production release tag at HEAD `<commit>`**
```

depending on the actual gate results.

- [ ] **Step 5: Commit**

```powershell
git add docs/release/2026-06-15-production-readiness-report.md docs/implementation-status.md
git commit -m "docs: record parser hardening release gates"
git push origin master
```

---

## Acceptance Checks

- Default target discovery no longer depends on LocateAnything alone.
- Per-image locator coverage is recorded and gates fail if either expected or actual is weak.
- Useless giant boxes do not satisfy coverage.
- Target-map artifacts are written for both expected and actual images.
- The sidecar reports lane counts, status, model, and license metadata.
- OmniParser and YOLO lanes are optional and explicit, not hidden dependencies.
- No user-authored target maps, ROI maps, ignore masks, or anchor dumps are introduced.
- `verify:calorix-live` and `verify:calorix-full-live` pass fresh before release.
- Foreground MCP live gate does not depend on a warm sidecar by accident.

## Gemini Research And Planning Input

Gemini 3.1 Pro Preview was asked to independently research whether LocateAnything is the wrong locator and propose a fix. Its recommendation matched the plan direction:

- LocateAnything is likely the wrong single source of truth for dense UI parsing.
- OmniParser is the strongest screen-parser candidate.
- YOLO UI-element models are fast and useful but need OCR and labels.
- LocateAnything should be hardened or demoted rather than trusted alone.

## Gemini Review

Gemini 3.1 Pro Preview reviewed this plan as researcher/planner and blocker reviewer.

- `AGREEMENT_STATUS: agree`
- `MUST_FIX: none`
- `SHOULD_FIX`: make multi-lane merge/NMS explicit so CV/OCR/YOLO/OmniParser do not flood downstream audit with duplicate boxes.

Change incorporated: Task 7 now adds `src/locator/nms.ts`, focused NMS tests, and an explicit `suppressDuplicateElements()` integration requirement.

Final blocker-only retry with Gemini 3.1 Pro Preview timed out once, then returned a concise approval-style response rather than the requested template. The response stated that the plan's multi-lane screen parser, deterministic CV/OCR, optional OmniParser/YOLO lanes, NMS deduplication, and strict per-image coverage scoring are solid and address the root cause of the live gate failure. No additional blocker was raised in that response.
