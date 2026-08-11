"""C++ LocateAnything worker using ctypes for the locate-anything.cpp shared library.

No Torch, no Eagle, no GPU. Dependency injection of the CDLL for testability.
"""

import ctypes
import io
import json
import math
import os
import re
import threading
import time
from ctypes import c_char_p, c_int, c_size_t, c_ubyte, c_void_p
from typing import Any

from PIL import Image

_EXPECTED_ABI_VERSION = 1

_DEFAULT_LIB_PATH = (
    "/home/agent-runner/projects/locate-anything.cpp/build-shared/liblocate_anything.so"
)

_DEFAULT_MODEL_PATH = "/home/agent-runner/projects/locate-anything.cpp/models/locate-anything-q4_k.gguf"

_DEFAULT_THREADS = 1

_MODEL_IDENTITY = "locate-anything.cpp/Q4_K"
_QUANTIZATION = "Q4_K"
_MODEL_SHA256 = "894088a00a2cd2bbb7f34b12893988dd0376c8ed92213a9f2cf6420f1e3901da"
_ENGINE_COMMIT = "77376ab332de918220f7a7e391542eefb5407c9f"

_PROVENANCE: dict[str, Any] = {
    "backend": "cpp",
    "model": _MODEL_IDENTITY,
    "quantization": _QUANTIZATION,
    "modelSha256": _MODEL_SHA256,
    "engineCommit": _ENGINE_COMMIT,
}

_LABEL_SANITIZE_RE = re.compile(r"<[^>]*>")


def _sanitize_label(label: str) -> str:
    """Remove parser tags from model labels to prevent injection into the answer string."""
    return _LABEL_SANITIZE_RE.sub("", label).strip()


def _resolve_env_int(env_var: str, default: int, lo: int, hi: int) -> int:
    """Resolve an integer environment variable with range validation."""
    raw = os.environ.get(env_var, "")
    if not raw:
        return default
    try:
        val = int(raw)
    except ValueError as exc:
        raise ValueError(f"{env_var} must be an integer; got {raw!r}") from exc
    if val < lo or val > hi:
        raise ValueError(f"{env_var} must be between {lo} and {hi}; got {val}")
    return val


def _resolve_env_path(env_var: str, default: str | None) -> str | None:
    """Resolve a path environment variable, returning None if unset."""
    val = os.environ.get(env_var, "")
    return val.strip() if val.strip() else default


class CppLocateAnythingWorker:
    """Worker that delegates inference to the locate-anything.cpp shared library."""

    _backend = "cpp"

    def __init__(
        self,
        cdll: Any = None,
        model_path: bytes | str | None = None,
        lib_path: str | None = None,
        n_threads: int | None = None,
    ) -> None:
        self._closed = True
        self._ctx: c_void_p | None = None
        self._lock = threading.Lock()
        self.abi_version: int = 0

        if model_path is None:
            model_path = _resolve_env_path("LOCATEANYTHING_CPP_MODEL_PATH", None)
        if model_path is None:
            model_path = _DEFAULT_MODEL_PATH
        if isinstance(model_path, str):
            model_path = model_path.encode("utf-8")

        if n_threads is None:
            n_threads = _resolve_env_int("LOCATEANYTHING_CPP_THREADS", _DEFAULT_THREADS, 1, 256)

        if cdll is not None:
            self._lib = cdll
        else:
            resolved = lib_path or _resolve_env_path("LOCATEANYTHING_CPP_LIBRARY_PATH", None) or _DEFAULT_LIB_PATH
            if not os.path.isfile(resolved):
                raise RuntimeError(f"shared library not found: {resolved}")
            self._lib = ctypes.CDLL(resolved)
            resolved_model = model_path.decode("utf-8") if isinstance(model_path, bytes) else model_path
            if not os.path.isfile(resolved_model):
                raise RuntimeError(f"model file not found: {resolved_model}")

        self._configure_signatures()

        self.abi_version = self._lib.la_capi_abi_version()
        if self.abi_version != _EXPECTED_ABI_VERSION:
            raise RuntimeError(
                f"ABI mismatch: expected {_EXPECTED_ABI_VERSION}, got {self.abi_version}"
            )

        try:
            self._ctx = self._lib.la_capi_load(model_path, n_threads)
        except Exception as exc:
            raise RuntimeError(f"Failed to load model: {exc}") from exc
        if not self._ctx:
            err = self._last_error(None)
            raise RuntimeError(f"Failed to load model: {err or 'unknown error'}")

        self._closed = False

    @property
    def provenance(self) -> dict[str, Any]:
        """Immutable provenance mapping for the locateanything lane metadata."""
        return dict(_PROVENANCE)

    def _configure_signatures(self) -> None:
        lib = self._lib
        lib.la_capi_abi_version.argtypes = []
        lib.la_capi_abi_version.restype = c_int

        lib.la_capi_load.argtypes = [c_char_p, c_int]
        lib.la_capi_load.restype = c_void_p

        lib.la_capi_free.argtypes = [c_void_p]
        lib.la_capi_free.restype = None

        lib.la_capi_locate_buffer.argtypes = [
            c_void_p,
            ctypes.POINTER(c_ubyte),
            c_size_t,
            c_char_p,
            c_int,
        ]
        lib.la_capi_locate_buffer.restype = c_void_p

        lib.la_capi_free_string.argtypes = [c_void_p]
        lib.la_capi_free_string.restype = None

        lib.la_capi_last_error.argtypes = [c_void_p]
        lib.la_capi_last_error.restype = c_char_p

    def _last_error(self, ctx: c_void_p | None) -> str:
        raw = self._lib.la_capi_last_error(ctx)
        if raw is None:
            return ""
        if isinstance(raw, bytes):
            return raw.decode("utf-8", errors="replace")
        return str(raw)

    def _encode_image(self, image: Image.Image) -> bytes:
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    def _call_locate_buffer(
        self, image_bytes: bytes, prompt: str, mode: int
    ) -> bytes:
        if not self._ctx:
            raise RuntimeError("worker context is not loaded")

        prompt_bytes = prompt.encode("utf-8")
        c_buf = (c_ubyte * len(image_bytes))(*image_bytes)
        try:
            ptr = self._lib.la_capi_locate_buffer(
                self._ctx, c_buf, len(image_bytes), prompt_bytes, mode
            )
        except Exception as exc:
            raise RuntimeError(f"locate_buffer failed: {exc}") from exc

        if not ptr:
            err = self._last_error(self._ctx)
            raise RuntimeError(f"locate_buffer returned null: {err or 'unknown error'}")

        try:
            return ctypes.string_at(ptr)
        finally:
            self._lib.la_capi_free_string(ptr)

    def _locate_buffer_raw(
        self, image_bytes: bytes, prompt: str, mode: int
    ) -> bytes:
        return self._call_locate_buffer(image_bytes, prompt, mode)

    @staticmethod
    def _generation_mode_to_int(mode: str) -> int:
        if mode == "slow":
            return 1
        if mode == "fast":
            return 2
        return 0

    @staticmethod
    def _is_valid_detection(det: dict[str, Any], image_width: int, image_height: int) -> bool:
        box = det.get("box")
        if not isinstance(box, list) or len(box) != 4:
            return False
        try:
            coords = [float(c) for c in box]
        except (TypeError, ValueError):
            return False
        if not all(math.isfinite(c) for c in coords):
            return False
        x1, y1, x2, y2 = coords
        if x2 <= x1 or y2 <= y1:
            return False
        if x1 < 0 or y1 < 0 or x2 > image_width or y2 > image_height:
            return False
        label = det.get("label", "")
        if not isinstance(label, str) or not label.strip():
            return False
        return True

    @staticmethod
    def _pixel_to_raw1000(coord: float, dim: int) -> int:
        return max(0, min(1000, round((coord / dim) * 1000)))

    @staticmethod
    def _detections_to_answer(
        detections: list[dict[str, Any]], max_boxes: int, image_width: int, image_height: int
    ) -> tuple[str, str | None]:
        parts: list[str] = []
        truncation_warning: str | None = None
        if len(detections) > max_boxes:
            truncation_warning = f"{len(detections) - max_boxes} valid detection(s) truncated to max_boxes={max_boxes}"
        for det in detections[:max_boxes]:
            x1, y1, x2, y2 = det["box"]
            raw_box = [
                CppLocateAnythingWorker._pixel_to_raw1000(x1, image_width),
                CppLocateAnythingWorker._pixel_to_raw1000(y1, image_height),
                CppLocateAnythingWorker._pixel_to_raw1000(x2, image_width),
                CppLocateAnythingWorker._pixel_to_raw1000(y2, image_height),
            ]
            label = _sanitize_label(det["label"])
            if not label:
                continue
            parts.append(
                f"<ref>{label}</ref><box><{raw_box[0]}><{raw_box[1]}><{raw_box[2]}><{raw_box[3]}></box>"
            )
        return "".join(parts), truncation_warning

    def _predict_unsafe(
        self,
        image: Image.Image,
        prompt: str,
        *,
        generation_mode: str = "hybrid",
        max_new_tokens: int = 512,
        top_k: int = 0,
        verbose: bool = False,
        max_boxes: int = 200,
        **kwargs: Any,
    ) -> dict[str, Any]:
        image_bytes = self._encode_image(image)
        mode_int = self._generation_mode_to_int(generation_mode)
        image_width, image_height = image.size

        raw = self._locate_buffer_raw(image_bytes, prompt, mode_int)

        try:
            decoded = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RuntimeError(f"invalid UTF-8 in locate_buffer result: {exc}") from exc

        try:
            data = json.loads(decoded)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"invalid JSON in locate_buffer result: {exc}") from exc

        detections_raw = data.get("detections")
        if not isinstance(detections_raw, list):
            raise RuntimeError(
                f"expected 'detections' list, got {type(detections_raw).__name__}"
            )

        valid = [d for d in detections_raw if self._is_valid_detection(d, image_width, image_height)]
        filtered_count = len(detections_raw) - len(valid)
        warnings: list[str] = []
        if filtered_count > 0:
            warnings.append(
                f"{filtered_count} detection(s) filtered: invalid coordinates or empty label"
            )

        answer, truncation_warning = self._detections_to_answer(valid, max_boxes, image_width, image_height)
        if truncation_warning:
            warnings.append(truncation_warning)

        return {
            "answer": answer,
            "warnings": warnings,
            "metadata": {
                "backend": "cpp",
                "model": _MODEL_IDENTITY,
                "quantization": _QUANTIZATION,
                "modelSha256": _MODEL_SHA256,
                "engineCommit": _ENGINE_COMMIT,
                "abiVersion": self.abi_version,
            },
        }

    def predict(
        self,
        image: Image.Image,
        prompt: str,
        *,
        generation_mode: str = "hybrid",
        max_new_tokens: int = 512,
        top_k: int = 0,
        verbose: bool = False,
        max_boxes: int = 200,
        **kwargs: Any,
    ) -> dict[str, Any]:
        with self._lock:
            return self._predict_unsafe(
                image,
                prompt,
                generation_mode=generation_mode,
                max_new_tokens=max_new_tokens,
                top_k=top_k,
                verbose=verbose,
                max_boxes=max_boxes,
                **kwargs,
            )

    def predict_many(
        self,
        image: Image.Image,
        queries: list[dict[str, str]],
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        with self._lock:
            for query in queries:
                results.append(self._predict_unsafe(image, query["prompt"], **kwargs))
        return results

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._ctx is not None:
            self._lib.la_capi_free(self._ctx)
            self._ctx = None

    def __enter__(self) -> "CppLocateAnythingWorker":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def __del__(self) -> None:
        self.close()
