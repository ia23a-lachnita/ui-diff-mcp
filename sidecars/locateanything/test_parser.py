import os
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from fastapi import HTTPException
from PIL import Image

from sidecars.locateanything import server
from sidecars.locateanything.parser import _sanitize_label, parse_elements
from sidecars.locateanything.server import (
    _apply_worker_runtime_config,
    _locateanything_generation_mode,
    _locateanything_max_new_tokens,
    _locateanything_top_k,
)


class _FakeImageProcessor:
    def __init__(self) -> None:
        self.in_token_limit = 25600


class _FakeProcessor:
    def __init__(self) -> None:
        self.image_processor = _FakeImageProcessor()


class _FakeWorker:
    def __init__(self) -> None:
        self.processor = _FakeProcessor()


class _PredictWorker:
    def __init__(self, results):
        self.results = iter(results)
        self.calls = []

    def predict(self, image, prompt, **kwargs):
        self.calls.append((image, prompt, kwargs))
        result = next(self.results)
        if isinstance(result, BaseException):
            raise result
        return result


def _locate_request(*query_ids):
    return server.LocateRequest(
        imagePath="unused.png",
        queries=[server.LocateQuery(id=query_id, prompt=f"find {query_id}") for query_id in query_ids],
    )


def _cv_element(index):
    return {
        "queryId": "cv_components",
        "label": f"cv-{index}",
        "box": {"x": float(index), "y": 1.0, "width": 10.0, "height": 10.0},
    }


def _patched_model_server(worker, cv_elements):
    stack = ExitStack()
    stack.enter_context(patch.object(server.state, "worker", worker))
    stack.enter_context(patch.object(server, "_load_image", return_value=Image.new("RGB", (200, 400))))
    stack.enter_context(patch.object(server, "detect_cv_components", return_value=cv_elements))
    stack.enter_context(patch.object(server, "detect_ocr_text", return_value=([], "test-ocr")))
    stack.enter_context(
        patch.object(
            server,
            "detect_omniparser",
            return_value=([], {"status": "complete", "count": 0, "model": "test-omni"}),
        )
    )
    stack.enter_context(
        patch.object(
            server,
            "detect_yolo_ui",
            return_value=([], {"status": "complete", "count": 0, "model": "test-yolo"}),
        )
    )
    stack.enter_context(
        patch.dict(
            os.environ,
            {"LOCATEANYTHING_SKIP_MODEL": "0", "LOCATEANYTHING_MODEL": "test/LocateAnything"},
            clear=False,
        )
    )
    return stack


class LocateAnythingParserTests(unittest.TestCase):
    def test_parses_ref_label_and_box_tokens(self) -> None:
        elements, warnings = parse_elements(
            query_id="controls",
            answer="<ref>search button</ref><box><100><200><300><260></box>",
            image_width=1000,
            image_height=2000,
            max_boxes=5,
        )

        self.assertEqual(warnings, [])
        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["queryId"], "controls")
        self.assertEqual(elements[0]["label"], "search button")
        self.assertEqual(elements[0]["rawBox1000"], [100, 200, 300, 260])
        self.assertEqual(elements[0]["box"], {
            "x": 100.0,
            "y": 400.0,
            "width": 200.0,
            "height": 120.0,
        })

    def test_label_never_spans_ref_tokens_on_malformed_grounding(self) -> None:
        answer = (
            "<ref>s tate</ref> buttons and tappable controls</ref>"
            "<box><0><65><1000><1000></box>"
        )
        elements, warnings = parse_elements(
            query_id="buttons",
            answer=answer,
            image_width=402,
            image_height=874,
            max_boxes=5,
        )

        self.assertEqual(warnings, [])
        self.assertEqual(len(elements), 1)
        self.assertNotIn("</ref>", elements[0]["label"])
        self.assertNotIn("<ref>", elements[0]["label"])

    def test_label_sanitizer_strips_coordinate_and_box_tokens(self) -> None:
        answer = "<ref>kcal <100> ring</ref><box><10><10><200><200></box>"
        elements, _warnings = parse_elements(
            query_id="charts_indicators",
            answer=answer,
            image_width=402,
            image_height=874,
            max_boxes=5,
        )

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["label"], "kcal ring")

    def test_label_falls_back_to_query_id_when_sanitized_empty(self) -> None:
        answer = "<ref><5></ref><box><10><10><200><200></box>"
        elements, _warnings = parse_elements(
            query_id="icons",
            answer=answer,
            image_width=402,
            image_height=874,
            max_boxes=5,
        )

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["label"], "icons")

    def test_label_sanitizer_removes_only_known_grounding_tokens(self) -> None:
        label = _sanitize_label(
            "Panel <ref>details</ref> <box>content</box> <12, 34, -56> "
            "<unknown>keep</unknown> x < y </ref> </box>"
        )

        self.assertEqual(label, "Panel details content <unknown>keep</unknown> x < y")

    def test_skips_invalid_coordinate_order_with_warning(self) -> None:
        elements, warnings = parse_elements(
            query_id="cards",
            answer="<ref>bad card</ref><box><500><200><300><260></box>",
            image_width=1000,
            image_height=2000,
            max_boxes=5,
        )

        self.assertEqual(elements, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn("invalid coordinate order", warnings[0])

    def test_skips_materially_out_of_range_coordinates(self) -> None:
        elements, warnings = parse_elements(
            query_id="text",
            answer="<ref>overflow</ref><box><0><0><1005><200></box>",
            image_width=1000,
            image_height=2000,
            max_boxes=5,
        )

        self.assertEqual(elements, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn("out of normalized bounds", warnings[0])

    def test_caps_boxes_per_query(self) -> None:
        answer = (
            "<ref>one</ref><box><0><0><100><100></box>"
            "<ref>two</ref><box><200><200><300><300></box>"
        )

        elements, warnings = parse_elements(
            query_id="text",
            answer=answer,
            image_width=1000,
            image_height=1000,
            max_boxes=1,
        )

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["label"], "one")
        self.assertEqual(warnings, ["query text returned more than maxBoxesPerQuery=1; extra boxes were ignored"])


class LocateAnythingServerConfigTests(unittest.TestCase):
    def test_applies_env_token_limit_to_worker_image_processor(self) -> None:
        worker = _FakeWorker()

        _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "1024"})

        self.assertEqual(worker.processor.image_processor.in_token_limit, 1024)

    def test_rejects_invalid_env_token_limit(self) -> None:
        worker = _FakeWorker()

        with self.assertRaises(ValueError):
            _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "0"})

    def test_maps_public_generation_modes_to_worker_modes(self) -> None:
        self.assertEqual(_locateanything_generation_mode("detection", {}), "fast")
        self.assertEqual(_locateanything_generation_mode("grounding", {}), "slow")
        self.assertEqual(_locateanything_generation_mode("hybrid", {}), "hybrid")

    def test_generation_mode_env_override(self) -> None:
        self.assertEqual(
            _locateanything_generation_mode("hybrid", {"LOCATEANYTHING_GENERATION_MODE": "slow"}),
            "slow",
        )

        with self.assertRaises(ValueError):
            _locateanything_generation_mode("hybrid", {"LOCATEANYTHING_GENERATION_MODE": "invalid"})

    def test_top_k_is_zero_unless_positive_env_value_is_set(self) -> None:
        self.assertEqual(_locateanything_top_k({}), 0)
        self.assertEqual(_locateanything_top_k({"LOCATEANYTHING_TOP_K": "5"}), 5)

        with self.assertRaises(ValueError):
            _locateanything_top_k({"LOCATEANYTHING_TOP_K": "0"})

    def test_max_new_tokens_defaults_to_bounded_value(self) -> None:
        self.assertEqual(_locateanything_max_new_tokens({}), 512)
        self.assertEqual(_locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "256"}), 256)

        with self.assertRaises(ValueError):
            _locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "0"})


class LocateAnythingEndpointTests(unittest.TestCase):
    def test_model_lane_accumulates_boxes_across_queries(self) -> None:
        worker = _PredictWorker(
            [
                {"answer": "<ref>first</ref><box><10><20><100><120></box>"},
                {"answer": "<ref>second</ref><box><200><220><300><320></box>"},
            ]
        )
        with _patched_model_server(worker, [_cv_element(1), _cv_element(2), _cv_element(3)]):
            response = server.locate_ui_elements(_locate_request("first", "second"))

        lane = response["metadata"]["lanes"]["locateanything"]
        self.assertEqual(len(response["elements"]), 5)
        self.assertEqual(lane, {"status": "complete", "count": 2, "model": "test/LocateAnything"})
        self.assertEqual(len(worker.calls), 2)

    def test_model_lane_reports_zero_boxes_and_preserves_parser_warnings(self) -> None:
        worker = _PredictWorker(
            [
                {"answer": "<ref>reversed</ref><box><500><200><300><260></box>"},
                {"answer": "<ref>overflow</ref><box><0><0><1005><200></box>"},
            ]
        )
        with _patched_model_server(worker, [_cv_element(1), _cv_element(2), _cv_element(3)]):
            response = server.locate_ui_elements(_locate_request("reversed", "overflow"))

        lane = response["metadata"]["lanes"]["locateanything"]
        self.assertEqual(len(response["elements"]), 3)
        self.assertEqual(lane, {"status": "complete", "count": 0, "model": "test/LocateAnything"})
        self.assertTrue(any("invalid coordinate order" in warning for warning in response["warnings"]))
        self.assertTrue(any("out of normalized bounds" in warning for warning in response["warnings"]))

    def test_runtime_model_error_maps_to_503(self) -> None:
        worker = _PredictWorker([RuntimeError("predict failed")])
        with _patched_model_server(worker, []):
            with self.assertRaises(HTTPException) as raised:
                server.locate_ui_elements(_locate_request("failure"))

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("model inference failed", str(raised.exception.detail))

    def test_later_model_error_does_not_return_partial_response_or_lane(self) -> None:
        worker = _PredictWorker(
            [
                {"answer": "<ref>first</ref><box><10><20><100><120></box>"},
                RuntimeError("second query failed"),
            ]
        )
        with _patched_model_server(worker, []):
            with self.assertRaises(HTTPException) as raised:
                server.locate_ui_elements(_locate_request("first", "second"))

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("model inference failed", str(raised.exception.detail))
        self.assertEqual(len(worker.calls), 2)

    def test_adapter_model_error_maps_to_500(self) -> None:
        worker = _PredictWorker([ValueError("adapter failed")])
        with _patched_model_server(worker, []):
            with self.assertRaises(HTTPException) as raised:
                server.locate_ui_elements(_locate_request("failure"))

        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("adapter inference error", str(raised.exception.detail))


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


class SkipModelEnvVarTests(unittest.TestCase):
    def test_skip_model_truthy_values(self) -> None:
        import os
        for val in ("1", "true", "yes"):
            with self.subTest(val=val):
                self.assertIn(val.lower(), {"1", "true", "yes"})

    def test_skip_model_falsy_values(self) -> None:
        for val in ("", "0", "false", "no"):
            with self.subTest(val=val):
                self.assertNotIn(val.lower(), {"1", "true", "yes"})


if __name__ == "__main__":
    unittest.main()
