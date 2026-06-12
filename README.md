# ui-diff-mcp

Successor project for `mobile-ui-diff-mcp`.

Current research/design spec:

- `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`

Rejected historical plan:

- `docs/superpowers/plans/2026-06-12-ui-diff-mcp-successor.md`

This repository is intended to become a general MCP server for comparing mobile app screenshots against mockup designs, with Calorix as the first demanding integration target.

## Installation

```bash
npm install
```

## Verification

```bash
npm run verify
```

## Build

```bash
npm run build
```

## Running the server

```bash
node C:/Users/xursc/projects/ui-diff-mcp/dist/index.js
```

## Environment Variables

Create a `.env` file in the root of the project and add the following variables:

- `OPENROUTER_API_KEY` (required)
- `LOCATEANYTHING_SIDECAR_URL` (optional, defaults to `http://127.0.0.1:39731`)
- `NVIDIA_API_KEY` (optional)
- `NVIDIA_VLM_BASE_URL` (optional)

This implementation requires no user-authored target map, ROI map, ignore mask, or anchor dump.
