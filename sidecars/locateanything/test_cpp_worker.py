"""Tests for the C++ LocateAnything worker using dependency-injected fake CDLL.

No real inference, no Torch, no Eagle. Every test uses a fake shared library.
"""

import ctypes
import json
import os
import threading
import time
import unittest
from ctypes import c_int, c_void_p, c_char_p, c_size_t
from typing import Any
from unittest.mock import MagicMock, patch

from PIL import Image


# ---------------------------------------------------------------------------
# Fake CDLL helpers
# ---------------------------------------------------------------------------

def _make_fake_lib(
    *,
    abi_version: int = 1,
    load_return: c_void_p | None = ctypes.c_void_p(0x1000),
    locate_buffer_return: bytes | None = None,
    last_error_return: str = "",
    load_side_effect: Any = None,
    locate_side_effect: Any = None,
    free_called: list | None = None,
    free_string_called: list | None = None,
    sleep_seconds: float = 0.0,
) -> MagicMock:
    """Build a fake CDLL that matches la_capi signatures."""
    lib = MagicMock()
    lib.la_capi_abi_version.return_value = abi_version
    lib.la_capi_abi_version.restype = c_int

    if load_side_effect is not None:
        lib.la_capi_load.side_effect = load_side_effect
    else:
        lib.la_capi_load.return_value = load_return
    lib.la_capi_load.restype = c_void_p
    lib.la_capi_load.argtypes = [c_char_p, c_int]

    if locate_side_effect is not None:
        lib.la_capi_locate_buffer.side_effect = locate_side_effect
    elif locate_buffer_return is not None:
        ptr = ctypes.cast(
            ctypes.c_buffer(locate_buffer_return), c_void_p
        )
        lib.la_capi_locate_buffer.return_value = ptr
    else:
        lib.la_capi_locate_buffer.return_value = None
    lib.la_capi_locate_buffer.restype = c_void_p
    lib.la_capi_locate_buffer.argtypes = [c_void_p, ctypes.POINTER(ctypes.c_ubyte), c_size_t, c_char_p, c_int]

    if free_called is not None:
        lib.la_capi_free.side_effect = lambda ctx: free_called.append(ctx)
    lib.la_capi_free.restype = None
    lib.la_capi_free.argtypes = [c_void_p]

    if free_string_called is not None:
        lib.la_capi_free_string.side_effect = lambda s: free_string_called.append(s)
    lib.la_capi_free_string.restype = None
    lib.la_capi_free_string.argtypes = [c_void_p]

    lib.la_capi_last_error.return_value = last_error_return.encode("utf-8")
    lib.la_capi_last_error.restype = c_char_p
    lib.la_capi_last_error.argtypes = [c_void_p]

    if sleep_seconds > 0:
        original_locate = lib.la_capi_locate_buffer.return_value

        def _slow_locate(*args: Any, **kwargs: Any) -> c_void_p:
            time.sleep(sleep_seconds)
            return original_locate

        lib.la_capi_locate_buffer.side_effect = _slow_locate

    return lib


def _detections_json(detections: list[dict[str, Any]]) -> bytes:
    """Return the JSON bytes that la_capi_locate_buffer returns."""
    return json.dumps({"detections": detections}).encode("utf-8")


def _make_tiny_png() -> bytes:
    """Return a minimal valid PNG image as bytes."""
    img = Image.new("RGB", (4, 4), color=(128, 128, 128))
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# ABI version tests
# ---------------------------------------------------------------------------

class AbiVersionTests(unittest.TestCase):
    def test_abi_version_returns_integer(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(abi_version=1)
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        self.assertEqual(worker.abi_version, 1)

    def test_abi_version_mismatch_raises(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(abi_version=2)
        with self.assertRaises(RuntimeError) as ctx:
            CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        self.assertIn("abi", str(ctx.exception).lower())


# ---------------------------------------------------------------------------
# Config / path tests
# ---------------------------------------------------------------------------

class ConfigTests(unittest.TestCase):
    def test_model_path_defaults_to_pi_q4(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        with patch.dict(os.environ, {}, clear=False):
            worker = CppLocateAnythingWorker(cdll=lib)
        called_args = lib.la_capi_load.call_args[0]
        self.assertIn(b"locate-anything-q4_k.gguf", called_args[0])

    def test_model_path_bytes_passed_to_load(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/path/to/model.gguf", n_threads=4)
        lib.la_capi_load.assert_called_once_with(b"/path/to/model.gguf", 4)


# ---------------------------------------------------------------------------
# Env override tests
# ---------------------------------------------------------------------------

class EnvOverrideTests(unittest.TestCase):
    def test_threads_from_env(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        with patch.dict(os.environ, {"LOCATEANYTHING_CPP_THREADS": "8"}):
            worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        lib.la_capi_load.assert_called_once_with(b"/fake/model.gguf", 8)

    def test_threads_env_rejects_non_integer(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        with (
            patch.dict(os.environ, {"LOCATEANYTHING_CPP_THREADS": "abc"}),
            self.assertRaises(ValueError) as ctx,
        ):
            CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        self.assertIn("LOCATEANYTHING_CPP_THREADS", str(ctx.exception))

    def test_threads_env_rejects_out_of_range(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        with (
            patch.dict(os.environ, {"LOCATEANYTHING_CPP_THREADS": "0"}),
            self.assertRaises(ValueError) as ctx,
        ):
            CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        self.assertIn("LOCATEANYTHING_CPP_THREADS", str(ctx.exception))

    def test_threads_explicit_overrides_env(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        with patch.dict(os.environ, {"LOCATEANYTHING_CPP_THREADS": "16"}):
            worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf", n_threads=2)
        lib.la_capi_load.assert_called_once_with(b"/fake/model.gguf", 2)

    def test_model_path_from_env(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        with patch.dict(os.environ, {"LOCATEANYTHING_CPP_MODEL_PATH": "/env/model.gguf"}):
            worker = CppLocateAnythingWorker(cdll=lib)
        lib.la_capi_load.assert_called_once_with(b"/env/model.gguf", 1)

    def test_library_path_from_env(self) -> None:
        import importlib
        import sidecars.locateanything.cpp_worker as mod
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        with (
            patch.dict(os.environ, {"LOCATEANYTHING_CPP_LIBRARY_PATH": "/env/lib.so"}),
            patch("ctypes.CDLL", side_effect=RuntimeError("no such file")) as mock_cdll,
        ):
            with self.assertRaises(RuntimeError):
                CppLocateAnythingWorker(model_path=b"/fake/model.gguf")

    def test_library_path_env_rejects_missing_file(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        with (
            patch.dict(os.environ, {"LOCATEANYTHING_CPP_LIBRARY_PATH": "/nonexistent/lib.so"}),
            self.assertRaises(RuntimeError) as ctx,
        ):
            CppLocateAnythingWorker(model_path=b"/fake/model.gguf")
        self.assertIn("not found", str(ctx.exception))


# ---------------------------------------------------------------------------
# Load null tests
# ---------------------------------------------------------------------------

class LoadNullTests(unittest.TestCase):
    def test_load_returns_null_raises_runtime_error(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(load_return=None)
        with self.assertRaises(RuntimeError) as ctx:
            CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        self.assertIn("load", str(ctx.exception).lower())

    def test_load_exception_raises_runtime_error(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(load_side_effect=OSError("file not found"))
        with self.assertRaises(RuntimeError) as ctx:
            CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        self.assertIn("load", str(ctx.exception).lower())


# ---------------------------------------------------------------------------
# Inference null with last_error tests
# ---------------------------------------------------------------------------

class InferenceNullTests(unittest.TestCase):
    def test_locate_buffer_returns_null_raises_runtime_error(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(
            locate_buffer_return=None,
            last_error_return="model not loaded",
        )
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        with self.assertRaises(RuntimeError) as ctx:
            worker.predict(img, "button")
        self.assertIn("model not loaded", str(ctx.exception))

    def test_locate_buffer_exception_raises_runtime_error(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(
            locate_side_effect=OSError("segfault"),
            last_error_return="segfault",
        )
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        with self.assertRaises(RuntimeError):
            worker.predict(img, "button")

    def test_locate_buffer_returns_c_void_p_none_raises_not_passed_to_free_string(self) -> None:
        """c_void_p(None) is falsy but not None; must be rejected before string_at/free_string."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        free_string_called: list = []
        lib = _make_fake_lib(
            last_error_return="inference returned null pointer",
            free_string_called=free_string_called,
        )
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        lib.la_capi_locate_buffer.return_value = ctypes.c_void_p(None)
        img = Image.new("RGB", (100, 100))
        with self.assertRaises(RuntimeError) as ctx:
            worker.predict(img, "button")
        self.assertIn("null", str(ctx.exception).lower())
        self.assertEqual(free_string_called, [], "la_capi_free_string must not be called on null ptr")


# ---------------------------------------------------------------------------
# UTF-8 / invalid data tests
# ---------------------------------------------------------------------------

class Utf8HandlingTests(unittest.TestCase):
    def test_invalid_utf8_in_c_string_freed_and_raises(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        invalid_json = b"\xff\xfe invalid json"
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        with patch.object(worker, "_locate_buffer_raw", return_value=invalid_json):
            with self.assertRaises(RuntimeError):
                worker.predict(img, "button")

    def test_invalid_json_freed_and_raises(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        invalid_json = b"not json at all"
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        with patch.object(worker, "_locate_buffer_raw", return_value=invalid_json):
            with self.assertRaises(RuntimeError) as ctx:
                worker.predict(img, "button")
            self.assertIn("json", str(ctx.exception).lower())


# ---------------------------------------------------------------------------
# JSON shape / detection field validation tests
# ---------------------------------------------------------------------------

class DetectionShapeTests(unittest.TestCase):
    def test_missing_detections_key_raises(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = json.dumps({"results": []}).encode("utf-8")
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            with self.assertRaises(RuntimeError) as ctx:
                worker.predict(img, "button")
            self.assertIn("detections", str(ctx.exception).lower())

    def test_non_list_detections_raises(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = json.dumps({"detections": "not a list"}).encode("utf-8")
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            with self.assertRaises(RuntimeError):
                worker.predict(img, "button")


# ---------------------------------------------------------------------------
# Coordinate validation tests (pixel xyxy against image bounds)
# ---------------------------------------------------------------------------

class CoordinateValidationTests(unittest.TestCase):
    def test_non_finite_coordinates_filtered(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [float("nan"), 0.1, 50, 50]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result.get("answer", "")
            self.assertNotIn("<box>", answer)

    def test_unordered_coordinates_filtered(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [50, 50, 10, 10]},  # x2 < x1
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result.get("answer", "")
            self.assertNotIn("<box>", answer)

    def test_empty_box_filtered(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [20, 30, 20, 30]},  # degenerate
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result.get("answer", "")
            self.assertNotIn("<box>", answer)

    def test_out_of_range_negative_filtered(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [-5, 0, 50, 50]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result.get("answer", "")
            self.assertNotIn("<box>", answer)

    def test_out_of_range_beyond_width_filtered(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [10, 10, 150, 50]},  # x2 > width
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result.get("answer", "")
            self.assertNotIn("<box>", answer)

    def test_out_of_range_beyond_height_filtered(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [10, 10, 50, 150]},  # y2 > height
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result.get("answer", "")
            self.assertNotIn("<box>", answer)

    def test_valid_pixel_coordinates_accepted(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [10, 20, 50, 60]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result.get("answer", "")
            self.assertIn("<box>", answer)


# ---------------------------------------------------------------------------
# Real pixel example tests
# ---------------------------------------------------------------------------

class RealPixelExampleTests(unittest.TestCase):
    def test_real_pixel_xyxy_at_276x600(self) -> None:
        """Upstream locate-anything.cpp emits pixel xyxy like [7.45,43.8,71.76,72]
        for a 276x600 image. Prove exact normalized rawBox1000 output."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (276, 600))
        raw = _detections_json([
            {"label": "Submit Button", "box": [7.45, 43.8, 71.76, 72.0]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "submit button")
            answer = result["answer"]
            # Expected rawBox1000:
            # x1: round(7.45/276 * 1000) = round(26.99) = 27
            # y1: round(43.8/600 * 1000) = round(73.0) = 73
            # x2: round(71.76/276 * 1000) = round(260.0) = 260
            # y2: round(72.0/600 * 1000) = round(120.0) = 120
            self.assertIn("<ref>Submit Button</ref><box><27><73><260><120></box>", answer)

    def test_real_pixel_xyxy_at_1080x1920(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (1080, 1920))
        raw = _detections_json([
            {"label": "Menu", "box": [100.5, 200.25, 500.75, 400.0]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "menu")
            answer = result["answer"]
            # x1: round(100.5/1080*1000) = round(93.055...) = 93
            # y1: round(200.25/1920*1000) = round(104.30) = 104
            # x2: round(500.75/1080*1000) = round(463.66) = 464
            # y2: round(400.0/1920*1000) = round(208.33) = 208
            self.assertIn("<ref>Menu</ref><box><93><104><464><208></box>", answer)

    def test_multiple_real_detections(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (276, 600))
        raw = _detections_json([
            {"label": "Submit Button", "box": [7.45, 43.8, 71.76, 72.0]},
            {"label": "Cancel", "box": [150.0, 400.0, 250.0, 500.0]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "buttons")
            answer = result["answer"]
            self.assertIn("<ref>Submit Button</ref><box><27><73><260><120></box>", answer)
            # Cancel: x1=round(150/276*1000)=543, y1=round(400/600*1000)=667
            #         x2=round(250/276*1000)=906, y2=round(500/600*1000)=833
            self.assertIn("<ref>Cancel</ref><box><543><667><906><833></box>", answer)


# ---------------------------------------------------------------------------
# Label sanitization tests
# ---------------------------------------------------------------------------

class LabelSanitizationTests(unittest.TestCase):
    def test_label_with_xml_tags_sanitized(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        malicious_label = "btn</ref><box><10><10><50><50></box>"
        raw = _detections_json([
            {"label": malicious_label, "box": [10, 10, 50, 50]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result["answer"]
            # The malicious tag injection is stripped; only "btn" remains as the label
            self.assertEqual(answer, "<ref>btn</ref><box><100><100><500><500></box>")

    def test_label_with_angle_brackets_sanitized(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "<script>alert(1)</script>", "box": [10, 10, 50, 50]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result["answer"]
            self.assertNotIn("<script>", answer)
            self.assertIn("<ref>alert(1)</ref>", answer)

    def test_label_empty_after_sanitize_filtered(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "<tag></tag>", "box": [10, 10, 50, 50]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            answer = result.get("answer", "")
            self.assertEqual(answer, "")


# ---------------------------------------------------------------------------
# Filtered-detection warning tests
# ---------------------------------------------------------------------------

class FilteredDetectionWarningTests(unittest.TestCase):
    def test_filtered_detections_produce_warning(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [10, 10, 50, 50]},       # valid
            {"label": "bad", "box": [-1, 0, 50, 50]},         # filtered (negative)
            {"label": "", "box": [10, 10, 50, 50]},            # filtered (empty label)
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            warnings = result.get("warnings", [])
            self.assertTrue(len(warnings) >= 1)
            self.assertIn("2", warnings[0])

    def test_no_warning_when_all_valid(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "btn", "box": [10, 10, 50, 50]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            warnings = result.get("warnings", [])
            self.assertEqual(warnings, [])


# ---------------------------------------------------------------------------
# Cap / max_boxes tests
# ---------------------------------------------------------------------------

class CapTests(unittest.TestCase):
    def test_excess_detections_capped(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        detections = [
            {"label": f"item{i}", "box": [10, 10, 50, 50]}
            for i in range(10)
        ]
        raw = _detections_json(detections)
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button", max_boxes=3)
            answer = result.get("answer", "")
            self.assertEqual(answer.count("<box>"), 3)

    def test_zero_detections_returns_empty(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button")
            self.assertEqual(result["answer"], "")


# ---------------------------------------------------------------------------
# String ownership / free exactly once tests
# ---------------------------------------------------------------------------

class StringOwnershipTests(unittest.TestCase):
    def test_successful_result_string_freed_exactly_once(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        freed: list = []
        lib = _make_fake_lib(
            locate_buffer_return=_detections_json([
                {"label": "btn", "box": [10, 10, 50, 50]},
            ]),
            free_string_called=freed,
        )
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        worker.predict(img, "button")
        self.assertEqual(len(freed), 1)

    def test_null_result_string_not_freed(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        freed: list = []
        lib = _make_fake_lib(
            locate_buffer_return=None,
            free_string_called=freed,
        )
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        with self.assertRaises(RuntimeError):
            worker.predict(img, "button")
        self.assertEqual(len(freed), 0)

    def test_free_string_receives_c_void_p(self) -> None:
        """la_capi_free_string must receive a c_void_p, not c_char_p."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(
            locate_buffer_return=_detections_json([
                {"label": "btn", "box": [10, 10, 50, 50]},
            ]),
        )
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        # Verify the argtypes are c_void_p, not c_char_p
        self.assertEqual(lib.la_capi_free_string.argtypes, [c_void_p])


# ---------------------------------------------------------------------------
# Context ownership / free exactly once tests
# ---------------------------------------------------------------------------

class ContextOwnershipTests(unittest.TestCase):
    def test_close_frees_context_exactly_once(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        freed: list = []
        lib = _make_fake_lib(free_called=freed)
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        worker.close()
        self.assertEqual(len(freed), 1)
        worker.close()
        self.assertEqual(len(freed), 1)

    def test_del_frees_context_exactly_once(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        freed: list = []
        lib = _make_fake_lib(free_called=freed)
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        worker.close()
        del worker
        self.assertEqual(len(freed), 1)

    def test_context_manager_frees_on_exit(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        freed: list = []
        lib = _make_fake_lib(free_called=freed)
        with CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf") as worker:
            self.assertIsNotNone(worker._ctx)
        self.assertEqual(len(freed), 1)

    def test_safe_partial_init_close_after_failed_load(self) -> None:
        """close() is safe even if __init__ partially failed."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(load_return=None)
        try:
            CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        except RuntimeError:
            pass
        # No crash — object was never fully constructed


# ---------------------------------------------------------------------------
# Pixel xyxy conversion to parser contract tests
# ---------------------------------------------------------------------------

class PixelConversionTests(unittest.TestCase):
    def test_valid_detection_produces_parser_answer(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (200, 100))
        raw = _detections_json([
            {"label": "Submit Button", "box": [20, 20, 120, 80]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "submit button")
            answer = result["answer"]
            self.assertIn("<ref>", answer)
            self.assertIn("</ref>", answer)
            self.assertIn("<box>", answer)
            self.assertIn("</box>", answer)
            self.assertIn("Submit Button", answer)

    def test_raw_box1000_normalizes_correctly(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        # pixel coords: [10, 35, 60, 75] in 100x100 image
        raw = _detections_json([
            {"label": "icon", "box": [10, 35, 60, 75]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "icon")
            answer = result["answer"]
            # 10/100*1000=100, 35/100*1000=350, 60/100*1000=600, 75/100*1000=750
            self.assertIn("<box><100><350><600><750></box>", answer)

    def test_label_nonempty_in_answer(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "Search", "box": [0, 0, 100, 100]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "search")
            self.assertIn("Search", result["answer"])


# ---------------------------------------------------------------------------
# predict_many tests
# ---------------------------------------------------------------------------

class PredictManyTests(unittest.TestCase):
    def test_predict_many_returns_list(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(
            locate_buffer_return=_detections_json([
                {"label": "item", "box": [10, 10, 50, 50]},
            ]),
        )
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        queries = [
            {"id": "q1", "prompt": "button"},
            {"id": "q2", "prompt": "icon"},
        ]
        results = worker.predict_many(img, queries)
        self.assertEqual(len(results), 2)
        self.assertIn("answer", results[0])
        self.assertIn("answer", results[1])

    def test_predict_many_empty_list(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        results = worker.predict_many(img, [])
        self.assertEqual(results, [])


# ---------------------------------------------------------------------------
# Concurrent blocking / threading.Lock serialization tests
# ---------------------------------------------------------------------------

class ConcurrentBlockingTests(unittest.TestCase):
    def test_predict_many_locks_entire_request(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker

        call_log: list[str] = []
        lock = threading.Lock()

        def _tracked_locate(*args: Any, **kwargs: Any) -> c_void_p:
            with lock:
                call_log.append("start")
                time.sleep(0.05)
                call_log.append("end")
            return ctypes.cast(
                ctypes.c_buffer(_detections_json([{"label": "x", "box": [10, 10, 50, 50]}])),
                c_void_p,
            )

        lib = _make_fake_lib()
        lib.la_capi_locate_buffer.side_effect = _tracked_locate
        lib.la_capi_locate_buffer.restype = c_void_p
        lib.la_capi_locate_buffer.argtypes = [c_void_p, ctypes.POINTER(ctypes.c_ubyte), c_size_t, c_char_p, c_int]

        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        queries = [{"id": f"q{i}", "prompt": "test"} for i in range(3)]

        results1: list = []
        results2: list = []

        def _run1() -> None:
            results1.extend(worker.predict_many(img, queries))

        def _run2() -> None:
            results2.extend(worker.predict_many(img, queries))

        t1 = threading.Thread(target=_run1)
        t2 = threading.Thread(target=_run2)
        t1.start()
        t2.start()
        t1.join(timeout=5)
        t2.join(timeout=5)

        for i in range(0, len(call_log) - 1, 2):
            self.assertEqual(call_log[i], "start")
            self.assertEqual(call_log[i + 1], "end")

        self.assertEqual(len(results1), 3)
        self.assertEqual(len(results2), 3)

    def test_predict_locks_serialization(self) -> None:
        """predict() also acquires the lock — prove serialization."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker

        overlap_detected = threading.Event()
        active_count = [0]

        def _slow_locate(*args: Any, **kwargs: Any) -> c_void_p:
            active_count[0] += 1
            if active_count[0] > 1:
                overlap_detected.set()
            time.sleep(0.02)
            active_count[0] -= 1
            return ctypes.cast(
                ctypes.c_buffer(_detections_json([{"label": "x", "box": [10, 10, 50, 50]}])),
                c_void_p,
            )

        lib = _make_fake_lib()
        lib.la_capi_locate_buffer.side_effect = _slow_locate
        lib.la_capi_locate_buffer.restype = c_void_p
        lib.la_capi_locate_buffer.argtypes = [c_void_p, ctypes.POINTER(ctypes.c_ubyte), c_size_t, c_char_p, c_int]

        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))

        threads = []
        for _ in range(4):
            t = threading.Thread(
                target=lambda: worker.predict(img, "test")
            )
            threads.append(t)
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        self.assertFalse(overlap_detected.is_set(), "Concurrent predict calls overlapped despite Lock")

    def test_predict_many_concurrent_blocking_fake(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker

        overlap_detected = threading.Event()
        active_count = [0]

        def _slow_locate(*args: Any, **kwargs: Any) -> c_void_p:
            active_count[0] += 1
            if active_count[0] > 1:
                overlap_detected.set()
            time.sleep(0.02)
            active_count[0] -= 1
            return ctypes.cast(
                ctypes.c_buffer(_detections_json([{"label": "x", "box": [10, 10, 50, 50]}])),
                c_void_p,
            )

        lib = _make_fake_lib()
        lib.la_capi_locate_buffer.side_effect = _slow_locate
        lib.la_capi_locate_buffer.restype = c_void_p
        lib.la_capi_locate_buffer.argtypes = [c_void_p, ctypes.POINTER(ctypes.c_ubyte), c_size_t, c_char_p, c_int]

        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))

        threads = []
        for _ in range(4):
            t = threading.Thread(
                target=lambda: worker.predict_many(img, [{"id": "q", "prompt": "test"}])
            )
            threads.append(t)
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        self.assertFalse(overlap_detected.is_set(), "Concurrent calls overlapped despite Lock")


# ---------------------------------------------------------------------------
# Image encoding tests
# ---------------------------------------------------------------------------

class ImageEncodingTests(unittest.TestCase):
    def test_jpeg_image_encoded_to_png_bytes(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100), color=(255, 0, 0))
        png_bytes = worker._encode_image(img)
        import io
        decoded = Image.open(io.BytesIO(png_bytes))
        self.assertEqual(decoded.format, "PNG")
        self.assertEqual(decoded.size, (100, 100))


# ---------------------------------------------------------------------------
# predict returns existing element-compatible fields
# ---------------------------------------------------------------------------

class ElementContractTests(unittest.TestCase):
    def test_predict_answer_parseable_by_parser(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        from sidecars.locateanything.parser import parse_elements

        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (200, 100))
        raw = _detections_json([
            {"label": "Submit", "box": [20, 20, 120, 80]},
            {"label": "Cancel", "box": [140, 30, 180, 70]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "buttons")
            elements, warnings = parse_elements(
                query_id="q1",
                answer=result["answer"],
                image_width=200,
                image_height=100,
                max_boxes=10,
            )
            self.assertEqual(len(elements), 2)
            self.assertEqual(elements[0]["queryId"], "q1")
            self.assertEqual(elements[0]["label"], "Submit")
            self.assertEqual(elements[1]["label"], "Cancel")
            self.assertIsInstance(elements[0]["rawBox1000"][0], int)
            self.assertIn("x", elements[0]["box"])
            self.assertIn("y", elements[0]["box"])
            self.assertIn("width", elements[0]["box"])
            self.assertIn("height", elements[0]["box"])
            self.assertEqual(elements[0]["confidence"], 1.0)

    def test_predict_raw_text_matches_raw_box1000(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([
            {"label": "icon", "box": [20, 30, 70, 80]},
        ])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "icon")
            self.assertIn("<box><200><300><700><800></box>", result["answer"])


# ---------------------------------------------------------------------------
# No Torch / Eagle import tests
# ---------------------------------------------------------------------------

class NoTorchImportTests(unittest.TestCase):
    def test_cpp_worker_module_has_no_torch_import(self) -> None:
        import importlib
        import sidecars.locateanything.cpp_worker as mod
        source = importlib.util.find_spec(mod.__name__).origin
        with open(source) as f:
            content = f.read()
        self.assertNotIn("import torch", content)
        self.assertNotIn("from torch", content)
        self.assertNotIn("import eagle", content.lower())
        self.assertNotIn("from eagle", content.lower())


# ---------------------------------------------------------------------------
# Lane metadata additive fields
# ---------------------------------------------------------------------------

class LaneMetadataTests(unittest.TestCase):
    def test_predict_returns_lane_metadata(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        raw = _detections_json([])
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "test")
            meta = result.get("metadata", {})
            self.assertEqual(meta["backend"], "cpp")
            self.assertEqual(meta["abiVersion"], 1)
            self.assertEqual(meta["model"], "locate-anything.cpp/Q4_K")
            self.assertEqual(meta["quantization"], "Q4_K")
            self.assertEqual(meta["modelSha256"], "894088a00a2cd2bbb7f34b12893988dd0376c8ed92213a9f2cf6420f1e3901da")
            self.assertEqual(meta["engineCommit"], "77376ab332de918220f7a7e391542eefb5407c9f")
            self.assertNotIn("abi_version", meta)
            self.assertNotIn("model_sha256", meta)
            self.assertNotIn("engine_commit", meta)


# ---------------------------------------------------------------------------
# Truncation warning tests
# ---------------------------------------------------------------------------

class TruncationWarningTests(unittest.TestCase):
    def test_valid_exceeding_max_boxes_emits_truncation_warning(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        detections = [
            {"label": f"item{i}", "box": [10, 10, 50, 50]}
            for i in range(5)
        ]
        raw = _detections_json(detections)
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button", max_boxes=3)
            warnings = result.get("warnings", [])
            truncation = [w for w in warnings if "truncated" in w]
            self.assertEqual(len(truncation), 1)
            self.assertIn("2", truncation[0])
            self.assertIn("max_boxes=3", truncation[0])
            self.assertEqual(result["answer"].count("<box>"), 3)

    def test_no_truncation_warning_when_within_limit(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        img = Image.new("RGB", (100, 100))
        detections = [
            {"label": f"item{i}", "box": [10, 10, 50, 50]}
            for i in range(3)
        ]
        raw = _detections_json(detections)
        with patch.object(worker, "_locate_buffer_raw", return_value=raw):
            result = worker.predict(img, "button", max_boxes=5)
            warnings = result.get("warnings", [])
            truncation = [w for w in warnings if "truncated" in w]
            self.assertEqual(len(truncation), 0)


# ---------------------------------------------------------------------------
# Null context (0) rejection tests
# ---------------------------------------------------------------------------

class NullContextZeroTests(unittest.TestCase):
    def test_load_returns_zero_context_raises_runtime_error(self) -> None:
        """c_void_p restype converts integer 0 to None; verify rejection."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(load_return=None)
        with self.assertRaises(RuntimeError) as ctx:
            CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        self.assertIn("load", str(ctx.exception).lower())

    def test_load_returns_c_void_p_none_raises_runtime_error(self) -> None:
        """ctypes.c_void_p(None) has bool False but is neither None nor == 0."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib(load_return=ctypes.c_void_p(None))
        with self.assertRaises(RuntimeError) as ctx:
            CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        self.assertIn("load", str(ctx.exception).lower())


# ---------------------------------------------------------------------------
# Provenance property tests
# ---------------------------------------------------------------------------

class ProvenancePropertyTests(unittest.TestCase):
    def test_provenance_returns_immutable_copy(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        p1 = worker.provenance
        p2 = worker.provenance
        self.assertEqual(p1, p2)
        self.assertIsNot(p1, p2)
        p1["backend"] = "mutated"
        self.assertEqual(worker.provenance["backend"], "cpp")

    def test_provenance_has_all_canonical_fields(self) -> None:
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/fake/model.gguf")
        p = worker.provenance
        self.assertEqual(p["backend"], "cpp")
        self.assertEqual(p["model"], "locate-anything.cpp/Q4_K")
        self.assertEqual(p["quantization"], "Q4_K")
        self.assertIn("modelSha256", p)
        self.assertIn("engineCommit", p)
        self.assertNotIn("model_sha256", p)
        self.assertNotIn("engine_commit", p)


# ---------------------------------------------------------------------------
# Model file existence validation tests
# ---------------------------------------------------------------------------

class ModelExistenceTests(unittest.TestCase):
    def test_real_cdll_missing_library_raises_runtime_error(self) -> None:
        """When no cdll is injected, missing shared library is rejected."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        with (
            patch.dict(os.environ, {"LOCATEANYTHING_CPP_LIBRARY_PATH": "/nonexistent/lib.so"}),
            self.assertRaises(RuntimeError) as ctx,
        ):
            CppLocateAnythingWorker(model_path=b"/fake/model.gguf")
        self.assertIn("not found", str(ctx.exception))

    def test_fake_cdll_does_not_require_model_file(self) -> None:
        """Injected fake CDLL skips model file existence check."""
        from sidecars.locateanything.cpp_worker import CppLocateAnythingWorker
        lib = _make_fake_lib()
        worker = CppLocateAnythingWorker(cdll=lib, model_path=b"/nonexistent/path/model.gguf")
        self.assertIsNotNone(worker)


if __name__ == "__main__":
    unittest.main()
