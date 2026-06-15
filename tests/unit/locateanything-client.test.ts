import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  LocatorUnavailableError,
  locateUiElements,
  type LocateAnythingRequest
} from "../../src/locator/locateanything-client.js";

const BASE_REQUEST: LocateAnythingRequest = {
  imagePath: "/tmp/test.png",
  queries: [{ id: "q1", prompt: "button" }],
  generationMode: "hybrid",
  maxBoxesPerQuery: 200
};

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Satisfy the health pre-flight that locateUiElements makes before sending the payload
      if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready: true, error: null }));
        return;
      }
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function startCaptureServer(): Promise<{
  port: number;
  getPostedBody: () => unknown;
}> {
  let postedBody: unknown;
  const { server: s, port } = await startServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: "nvidia/LocateAnything-3B",
      image: { width: 1, height: 1 },
      elements: [],
      warnings: []
    }));
  });
  server = s;
  return { port, getPostedBody: () => postedBody };
}

let server: http.Server | null = null;
let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-locator-client-"));
});

afterEach(async () => {
  if (server) {
    await stopServer(server);
    server = null;
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("locateUiElements", () => {
  it("sends image bytes so remote sidecars do not need the same filesystem", async () => {
    const pngPath = path.join(tmpDir, "fixture.png");
    await fs.writeFile(
      pngPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      )
    );

    const { port, getPostedBody } = await startCaptureServer();

    await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: { ...BASE_REQUEST, imagePath: pngPath },
      timeoutMs: 5000
    });

    expect(getPostedBody()).toMatchObject({
      imagePath: pngPath,
      imageMimeType: "image/png",
      imageBase64: expect.any(String)
    });
  });

  it("preserves a caller-provided image payload", async () => {
    const { port, getPostedBody } = await startCaptureServer();

    await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: {
        ...BASE_REQUEST,
        imagePath: "remote-trace.jpeg",
        imageBase64: "already-encoded",
        imageMimeType: "image/jpeg"
      },
      timeoutMs: 5000
    });

    expect(getPostedBody()).toMatchObject({
      imagePath: "remote-trace.jpeg",
      imageBase64: "already-encoded",
      imageMimeType: "image/jpeg"
    });
  });

  it("uses jpeg MIME type when enriching jpeg files", async () => {
    const jpegPath = path.join(tmpDir, "fixture.jpeg");
    await fs.writeFile(jpegPath, Buffer.from("not-a-real-jpeg-but-sent-as-bytes"));
    const { port, getPostedBody } = await startCaptureServer();

    await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: { ...BASE_REQUEST, imagePath: jpegPath },
      timeoutMs: 5000
    });

    expect(getPostedBody()).toMatchObject({
      imagePath: jpegPath,
      imageMimeType: "image/jpeg",
      imageBase64: Buffer.from("not-a-real-jpeg-but-sent-as-bytes").toString("base64")
    });
  });

  it("keeps path-only compatibility when the image cannot be read", async () => {
    const missingPath = path.join(tmpDir, "missing.webp");
    const { port, getPostedBody } = await startCaptureServer();

    await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: { ...BASE_REQUEST, imagePath: missingPath },
      timeoutMs: 5000
    });

    expect(getPostedBody()).toEqual({
      ...BASE_REQUEST,
      imagePath: missingPath
    });
  });

  it("keeps path-only compatibility for unsupported image extensions", async () => {
    const bmpPath = path.join(tmpDir, "fixture.bmp");
    await fs.writeFile(bmpPath, Buffer.from("bytes"));
    const { port, getPostedBody } = await startCaptureServer();

    await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: { ...BASE_REQUEST, imagePath: bmpPath },
      timeoutMs: 5000
    });

    expect(getPostedBody()).toEqual({
      ...BASE_REQUEST,
      imagePath: bmpPath
    });
  });

  it("parses a valid sidecar response", async () => {
    const body = JSON.stringify({
      model: "nvidia/LocateAnything-3B",
      image: { width: 200, height: 400 },
      elements: [
        {
          queryId: "q1",
          label: "Sign in button",
          box: { x: 10, y: 20, width: 80, height: 40 },
          rawBox1000: [50, 50, 400, 100],
          confidence: 0.92
        }
      ],
      warnings: []
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

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.label).toBe("Sign in button");
  });

  it("throws for a box that exceeds image bounds", async () => {
    const body = JSON.stringify({
      model: "nvidia/LocateAnything-3B",
      image: { width: 100, height: 100 },
      elements: [
        {
          queryId: "q1",
          label: "out of bounds",
          box: { x: 80, y: 80, width: 40, height: 40 },
          rawBox1000: [800, 800, 400, 400],
          confidence: 0.7
        }
      ],
      warnings: []
    });

    const { server: s, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    server = s;

    await expect(
      locateUiElements({
        endpoint: `http://127.0.0.1:${port}`,
        request: BASE_REQUEST,
        timeoutMs: 5000
      })
    ).rejects.toThrow(/out of image bounds/);
  });

  it("rescales element coordinates from resized to original image space when maxDimension is set", async () => {
    // 400×800 PNG; with maxDimension=200 sharp will resize to 100×200 (scale 0.25)
    const pngPath = path.join(tmpDir, "large.png");
    await sharp({
      create: { width: 400, height: 800, channels: 3, background: { r: 128, g: 128, b: 128 } }
    }).png().toFile(pngPath);

    // Sidecar sees a 100×200 image and reports an element in that coordinate space
    const body = JSON.stringify({
      model: "nvidia/LocateAnything-3B",
      image: { width: 100, height: 200 },
      elements: [{
        queryId: "q1", label: "button",
        box: { x: 20, y: 40, width: 10, height: 5 },
        rawBox1000: [200, 200, 100, 25], confidence: 0.9
      }],
      warnings: []
    });

    const { server: s, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    server = s;

    const result = await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: { ...BASE_REQUEST, imagePath: pngPath },
      timeoutMs: 5000,
      maxDimension: 200
    });

    // Coordinates must be scaled back to the 400×800 original space (factor ×4)
    expect(result.image).toEqual({ width: 400, height: 800 });
    expect(result.elements[0]?.box).toEqual({ x: 80, y: 160, width: 40, height: 20 });
  });

  it("does not rescale coordinates when the image fits within maxDimension", async () => {
    // 50×50 PNG — smaller than maxDimension=200, so sharp sends it as-is
    const pngPath = path.join(tmpDir, "small.png");
    await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 0, b: 0 } }
    }).png().toFile(pngPath);

    const body = JSON.stringify({
      model: "nvidia/LocateAnything-3B",
      image: { width: 50, height: 50 },
      elements: [{
        queryId: "q1", label: "icon",
        box: { x: 5, y: 5, width: 10, height: 10 },
        rawBox1000: [100, 100, 200, 200], confidence: 0.8
      }],
      warnings: []
    });

    const { server: s, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    server = s;

    const result = await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: { ...BASE_REQUEST, imagePath: pngPath },
      timeoutMs: 5000,
      maxDimension: 200
    });

    // No rescaling — coordinates unchanged
    expect(result.image).toEqual({ width: 50, height: 50 });
    expect(result.elements[0]?.box).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it("skips coordinate rescaling when imageBase64 is already provided", async () => {
    // When the caller pre-encodes the image, we cannot know its original dimensions
    const body = JSON.stringify({
      model: "nvidia/LocateAnything-3B",
      image: { width: 100, height: 100 },
      elements: [{
        queryId: "q1", label: "tab",
        box: { x: 10, y: 10, width: 20, height: 5 },
        rawBox1000: [100, 100, 200, 50], confidence: 0.85
      }],
      warnings: []
    });

    const { server: s, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    server = s;

    const result = await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: { ...BASE_REQUEST, imageBase64: "abc==", imageMimeType: "image/png" },
      timeoutMs: 5000,
      maxDimension: 200
    });

    expect(result.elements[0]?.box).toEqual({ x: 10, y: 10, width: 20, height: 5 });
  });

  it("throws LocatorUnavailableError on HTTP 503", async () => {
    const { server: s, port } = await startServer((_req, res) => {
      res.writeHead(503);
      res.end("Service Unavailable");
    });
    server = s;

    const err = await locateUiElements({
      endpoint: `http://127.0.0.1:${port}`,
      request: BASE_REQUEST,
      timeoutMs: 5000
    }).catch(e => e);

    expect(err).toBeInstanceOf(LocatorUnavailableError);
    expect((err as LocatorUnavailableError).code).toBe("locator_unavailable");
    expect((err as LocatorUnavailableError).status).toBe(503);
  });

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
});
