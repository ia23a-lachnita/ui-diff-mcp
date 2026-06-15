import unittest

from sidecars.locateanything.parser import parse_elements
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

    def test_top_k_is_none_unless_positive_env_value_is_set(self) -> None:
        self.assertIsNone(_locateanything_top_k({}))
        self.assertEqual(_locateanything_top_k({"LOCATEANYTHING_TOP_K": "5"}), 5)

        with self.assertRaises(ValueError):
            _locateanything_top_k({"LOCATEANYTHING_TOP_K": "0"})

    def test_max_new_tokens_defaults_to_bounded_value(self) -> None:
        self.assertEqual(_locateanything_max_new_tokens({}), 512)
        self.assertEqual(_locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "256"}), 256)

        with self.assertRaises(ValueError):
            _locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "0"})


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


if __name__ == "__main__":
    unittest.main()
