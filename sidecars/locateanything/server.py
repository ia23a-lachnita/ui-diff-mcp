import base64
import io
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from PIL import Image, UnidentifiedImageError

from sidecars.locateanything.parser import parse_elements


class LocateQuery(BaseModel):
    id: str = Field(min_length=1)
    prompt: str = Field(min_length=1)


class LocateRequest(BaseModel):
    imagePath: str = Field(min_length=1)
    imageBase64: str | None = Field(default=None, min_length=1)
    imageMimeType: Literal["image/png", "image/jpeg", "image/webp"] | None = None
    queries: list[LocateQuery] = Field(min_length=1)
    generationMode: Literal["detection", "grounding", "hybrid"] = "hybrid"
    maxBoxesPerQuery: int = Field(default=200, gt=0, le=500)


class AppState:
    worker: Any | None = None
    load_error: str | None = None


state = AppState()


def _apply_worker_runtime_config(worker: Any, env: dict[str, str]) -> None:
    raw_token_limit = env.get("LOCATEANYTHING_IN_TOKEN_LIMIT")
    if not raw_token_limit:
        return

    try:
        token_limit = int(raw_token_limit)
    except ValueError as exc:
        raise ValueError("LOCATEANYTHING_IN_TOKEN_LIMIT must be an integer") from exc

    if token_limit < 64 or token_limit > 25600:
        raise ValueError("LOCATEANYTHING_IN_TOKEN_LIMIT must be between 64 and 25600")

    image_processor = getattr(getattr(worker, "processor", None), "image_processor", None)
    if image_processor is None or not hasattr(image_processor, "in_token_limit"):
        raise ValueError("LocateAnything worker does not expose processor.image_processor.in_token_limit")

    image_processor.in_token_limit = token_limit


def _load_image(request: LocateRequest) -> Image.Image:
    try:
        if request.imageBase64:
            raw = base64.b64decode(request.imageBase64, validate=True)
            return Image.open(io.BytesIO(raw)).convert("RGB")
        return Image.open(request.imagePath).convert("RGB")
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise HTTPException(status_code=400, detail=f"unreadable image: {exc}") from exc


def _locateanything_generation_mode(mode: str, env: dict[str, str]) -> str:
    override = env.get("LOCATEANYTHING_GENERATION_MODE")
    if override:
        if override not in {"fast", "slow", "hybrid"}:
            raise ValueError("LOCATEANYTHING_GENERATION_MODE must be fast, slow, or hybrid")
        return override

    if mode == "detection":
        return "fast"
    if mode == "grounding":
        return "slow"
    return "hybrid"


def _locateanything_top_k(env: dict[str, str]) -> int | None:
    raw_top_k = env.get("LOCATEANYTHING_TOP_K")
    if not raw_top_k:
        return None

    try:
        top_k = int(raw_top_k)
    except ValueError as exc:
        raise ValueError("LOCATEANYTHING_TOP_K must be an integer") from exc

    if top_k < 1:
        raise ValueError("LOCATEANYTHING_TOP_K must be at least 1")
    return top_k


def _locateanything_max_new_tokens(env: dict[str, str]) -> int:
    raw_max_new_tokens = env.get("LOCATEANYTHING_MAX_NEW_TOKENS", "512")
    try:
        max_new_tokens = int(raw_max_new_tokens)
    except ValueError as exc:
        raise ValueError("LOCATEANYTHING_MAX_NEW_TOKENS must be an integer") from exc

    if max_new_tokens < 1 or max_new_tokens > 2048:
        raise ValueError("LOCATEANYTHING_MAX_NEW_TOKENS must be between 1 and 2048")
    return max_new_tokens


def _create_worker() -> Any:
    embodied_dir = os.environ.get("LOCATEANYTHING_EAGLE_EMBODIED_DIR")
    if embodied_dir:
        sys.path.insert(0, embodied_dir)

    import torch
    from locateanything_worker import LocateAnythingWorker

    model = os.environ.get("LOCATEANYTHING_MODEL", "nvidia/LocateAnything-3B")
    device = os.environ.get("LOCATEANYTHING_DEVICE", "cuda")
    dtype_name = os.environ.get("LOCATEANYTHING_DTYPE", "bfloat16")
    dtype = torch.bfloat16 if dtype_name == "bfloat16" else torch.float16
    worker = LocateAnythingWorker(model, device=device, dtype=dtype)
    _apply_worker_runtime_config(worker, os.environ)
    return worker


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        state.worker = _create_worker()
    except Exception as exc:
        state.load_error = f"{type(exc).__name__}: {exc}"
    yield


app = FastAPI(title="LocateAnything UI Diff Sidecar", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "model": os.environ.get("LOCATEANYTHING_MODEL", "nvidia/LocateAnything-3B"),
        "ready": state.worker is not None,
        "error": state.load_error,
        "inTokenLimit": getattr(
            getattr(getattr(state.worker, "processor", None), "image_processor", None),
            "in_token_limit",
            None,
        ),
    }


@app.post("/v1/locate-ui-elements")
def locate_ui_elements(request: LocateRequest) -> dict[str, Any]:
    if state.worker is None:
        detail = state.load_error or "LocateAnythingWorker is not loaded"
        raise HTTPException(status_code=503, detail=detail)

    image = _load_image(request)
    image_width, image_height = image.size
    all_elements: list[dict[str, Any]] = []
    warnings: list[str] = []

    for query in request.queries:
        try:
            result = state.worker.predict(
                image,
                query.prompt,
                generation_mode=_locateanything_generation_mode(request.generationMode, os.environ),
                max_new_tokens=_locateanything_max_new_tokens(os.environ),
                top_k=_locateanything_top_k(os.environ),
                verbose=False,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=f"model inference failed: {exc}") from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"adapter inference error: {exc}") from exc

        answer = str(result.get("answer", ""))
        elements, parse_warnings = parse_elements(
            query_id=query.id,
            answer=answer,
            image_width=image_width,
            image_height=image_height,
            max_boxes=request.maxBoxesPerQuery,
        )
        all_elements.extend(elements)
        warnings.extend(parse_warnings)

    return {
        "model": os.environ.get("LOCATEANYTHING_MODEL", "nvidia/LocateAnything-3B"),
        "image": {"width": image_width, "height": image_height},
        "elements": all_elements,
        "warnings": warnings,
    }
