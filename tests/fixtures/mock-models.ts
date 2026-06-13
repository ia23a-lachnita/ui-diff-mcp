import { vi } from "vitest";
import type { UiCriterion } from "../../src/schemas/core.js";

export interface ModelCallSpec {
  criterion: UiCriterion;
  hasDiff: boolean;
  severity?: "low" | "medium" | "high";
  title?: string;
  evidence?: string[];
  reviewerDecision?: "accepted" | "rejected" | "needs_escalation";
}

export interface MockFetchOptions {
  sidecarImageWidth?: number;
  sidecarImageHeight?: number;
}

function makeSidecarFetchResponse(width: number, height: number): unknown {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      model: "nvidia/LocateAnything-3B",
      image: { width, height },
      elements: [
        {
          queryId: "button",
          label: "Sign in button",
          box: { x: 20, y: 50, width: 160, height: 44 },
          rawBox1000: [100, 125, 800, 110],
          confidence: 0.91
        }
      ],
      warnings: []
    })
  };
}

export function makeMockFetch(specs: ModelCallSpec[], fetchOpts?: MockFetchOptions): ReturnType<typeof vi.fn> {
  const queue: Array<() => Promise<unknown>> = [];

  for (const spec of specs) {
    queue.push(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        model: "qwen/auditor",
        choices: [{
          message: {
            content: JSON.stringify({
              hasDiff: spec.hasDiff,
              severity: spec.severity ?? "medium",
              title: spec.title ?? `${spec.criterion} difference`,
              evidence: spec.evidence ?? ["visual difference detected"]
            })
          }
        }]
      })
    }));

    queue.push(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        model: "google/reviewer",
        choices: [{
          message: {
            content: JSON.stringify({
              decision: spec.reviewerDecision ?? "accepted",
              reason: "Visual difference confirmed."
            })
          }
        }]
      })
    }));
  }

  let index = 0;
  return vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
    // Route sidecar requests back to a valid sidecar-shaped response so Zod
    // parsing in locateanything-client.ts succeeds.
    if (typeof url === "string" && url.includes("/v1/locate-ui-elements")) {
      return Promise.resolve(
        makeSidecarFetchResponse(
          fetchOpts?.sidecarImageWidth ?? 200,
          fetchOpts?.sidecarImageHeight ?? 400
        )
      );
    }

    // Detect probe calls by json_schema name; return passing probe result so
    // required models are not treated as unavailable in full-mode tests.
    const bodyStr = init?.body;
    if (typeof bodyStr === "string") {
      try {
        const body = JSON.parse(bodyStr) as Record<string, unknown>;
        const rf = body["response_format"] as Record<string, unknown> | undefined;
        const js = rf?.["json_schema"] as Record<string, unknown> | undefined;
        if (js?.["name"] === "probe_result") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              model: String(body["model"] ?? "probe-model"),
              choices: [{ message: { content: '{"dominantColor":"blue","hasRedRect":true}' } }]
            })
          });
        }
      } catch {
        // non-JSON body: fall through to queue
      }
    }

    const handler = queue[index];
    index = Math.min(index + 1, queue.length - 1);
    return handler ? handler() : Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        model: "fallback",
        choices: [{ message: { content: '{"hasDiff":false}' } }]
      })
    });
  });
}
