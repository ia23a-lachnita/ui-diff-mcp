import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const server = http.createServer(handler);
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

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    await stopServer(server);
    server = null;
  }
});

describe("locateUiElements", () => {
  it("parses a valid sidecar response", async () => {
    const body = JSON.stringify({
      model: "nvidia/LocateAnything-3B",
      image: { width: 200, height: 400 },
      elements: [
        {
          queryId: "q1",
          label: "Sign in button",
          box: { x: 10, y: 20, width: 80, height: 40 },
          rawBox1000: { x: 50, y: 50, width: 400, height: 100 },
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
          rawBox1000: { x: 800, y: 800, width: 400, height: 400 },
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
});
