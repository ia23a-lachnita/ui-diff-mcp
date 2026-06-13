import http from "node:http";

export interface MockSidecarOptions {
  imageWidth: number;
  imageHeight: number;
}

function makeSidecarResponse(width: number, height: number): string {
  return JSON.stringify({
    model: "nvidia/LocateAnything-3B",
    image: { width, height },
    elements: [
      {
        queryId: "text",
        label: "Welcome heading",
        box: { x: 10, y: 20, width: 180, height: 30 },
        rawBox1000: [50, 50, 900, 75],
        confidence: 0.94,
        rawText: "Welcome"
      },
      {
        queryId: "button",
        label: "Sign in button",
        box: { x: 20, y: 80, width: 160, height: 44 },
        rawBox1000: [100, 200, 800, 110],
        confidence: 0.91
      },
      {
        queryId: "icon",
        label: "Logo icon",
        box: { x: 80, y: 140, width: 40, height: 40 },
        rawBox1000: [400, 350, 200, 100],
        confidence: 0.88
      },
      {
        queryId: "card",
        label: "Main card",
        box: { x: 5, y: 200, width: 190, height: 120 },
        rawBox1000: [25, 500, 950, 300],
        confidence: 0.85
      }
    ],
    warnings: []
  });
}

export interface MockSidecar {
  server: http.Server;
  port: number;
  url: string;
  requests: Array<{ queries: unknown[] }>;
  stop(): Promise<void>;
}

export function startMockSidecar(opts: MockSidecarOptions): Promise<MockSidecar> {
  return new Promise((resolve, reject) => {
    const requests: Array<{ queries: unknown[] }> = [];
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/locate-ui-elements") {
        let body = "";
        req.on("data", chunk => {
          body += chunk;
        });
        req.on("end", () => {
          requests.push(JSON.parse(body) as { queries: unknown[] });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(makeSidecarResponse(opts.imageWidth, opts.imageHeight));
        });
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      const port = addr.port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        stop: () => new Promise(res => server.close(() => res()))
      });
    });
  });
}
