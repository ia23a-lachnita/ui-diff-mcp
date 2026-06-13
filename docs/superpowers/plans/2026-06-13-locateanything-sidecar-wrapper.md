# LocateAnything Sidecar Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runnable LocateAnything sidecar adapter so live release gates can call a real `/v1/locate-ui-elements` endpoint.

**Architecture:** Keep TypeScript orchestration in the MCP and isolate Python/CUDA model loading in a FastAPI sidecar. Send image bytes from the MCP client so the sidecar can run locally or on a remote GPU without sharing the same filesystem.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Python 3.11+, FastAPI, Pillow, NVIDIA `LocateAnythingWorker` from NVlabs/Eagle.

---

## Task 1: Extend The Locator HTTP Payload

**Files:**
- Modify: `src/locator/locateanything-client.ts`
- Modify: `tests/unit/locateanything-client.test.ts`

- [x] Add optional `imageBase64` and `imageMimeType` to `LocateAnythingRequestSchema`.
- [x] Add a unit test proving `locateUiElements` sends `imageBase64` when only `imagePath` is supplied.
- [x] Implement MIME detection for `.png`, `.jpg`, `.jpeg`, and `.webp`.
- [x] Run `npm run test -- tests/unit/locateanything-client.test.ts` and confirm the new test passes.

## Task 2: Add The Python Sidecar Adapter

**Files:**
- Create: `sidecars/locateanything/__init__.py`
- Create: `sidecars/locateanything/parser.py`
- Create: `sidecars/locateanything/server.py`
- Create: `sidecars/locateanything/test_parser.py`
- Create: `sidecars/locateanything/requirements.txt`
- Create: `scripts/start-locateanything-sidecar.ps1`

- [x] Add parser tests for `<ref>label</ref><box><x1><y1><x2><y2></box>` output, invalid coordinates, max box caps, and warning behavior.
- [x] Implement parser functions that return MCP-shaped element records.
- [x] Implement FastAPI `/v1/locate-ui-elements` with `imageBase64` preferred and `imagePath` as compatibility input.
- [x] Add startup-time `LocateAnythingWorker` loading and 503 responses for model unavailable/OOM errors.
- [x] Run `python -m unittest sidecars.locateanything.test_parser`.

## Task 3: Document And Track The Live-Gate Path

**Files:**
- Modify: `README.md`
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `docs/implementation-status.md`

- [x] Document sidecar setup, local VRAM caveat, and remote GPU URL support.
- [x] Add Calorix live image paths to the optional smoke example.
- [x] Record Gemini review outcome and the new live-gate unblocker status.
- [x] Run `npm run verify`, `npm run test:coverage`, `python -m unittest sidecars.locateanything.test_parser`, and `git diff --check`.
- [x] Commit and push all changes.

## Gemini Review

Gemini 3 Pro Preview reviewed the sidecar design on 2026-06-13. The useful blocker was that `imagePath` alone couples the MCP and sidecar to the same filesystem. This plan resolves that by adding `imageBase64` and `imageMimeType` while keeping `imagePath` for traceability and compatibility.
