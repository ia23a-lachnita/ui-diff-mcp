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


def _load_image(request: LocateRequest) -> Image.Image:
    try:
        if request.imageBase64:
            raw = base64.b64decode(request.imageBase64, validate=True)
            return Image.open(io.BytesIO(raw)).convert("RGB")
        return Image.open(request.imagePath).convert("RGB")
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise HTTPException(status_code=400, detail=f"unreadable image: {exc}") from exc


def _locateanything_generation_mode(mode: str) -> str:
    return "hybrid" if mode in {"detection", "grounding", "hybrid"} else "hybrid"


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
    return LocateAnythingWorker(model, device=device, dtype=dtype)


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
                generation_mode=_locateanything_generation_mode(request.generationMode),
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
