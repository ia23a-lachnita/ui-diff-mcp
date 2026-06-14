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

function makeSseBody(jsonContent: string, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = [
    `data: ${JSON.stringify({ model, choices: [{ delta: { content: jsonContent } }] })}`,
    `data: [DONE]`,
    ``
  ].join("\n");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    }
  });
}

function makeSseResponse(jsonContent: string, model: string): unknown {
  return {
    ok: true,
    status: 200,
    body: makeSseBody(jsonContent, model)
  };
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
  const queue: Array<() => unknown> = [];

  for (const spec of specs) {
    queue.push(() => makeSseResponse(
      JSON.stringify({
        hasDiff: spec.hasDiff,
        severity: spec.severity ?? "medium",
        title: spec.title ?? `${spec.criterion} difference`,
        evidence: spec.evidence ?? ["visual difference detected"]
      }),
      "qwen/auditor"
    ));

    queue.push(() => makeSseResponse(
      JSON.stringify({
        decision: spec.reviewerDecision ?? "accepted",
        reason: "Visual difference confirmed."
      }),
      "google/reviewer"
    ));
  }

  let index = 0;
  return vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
    // OpenRouter key quota lookup — return sufficient quota so the preflight passes
    if (typeof url === "string" && url.includes("openrouter.ai/api/v1/key")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ is_free_tier: false, limit_remaining: 1000, limit: 1000 })
      });
    }

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

    // Detect schema-named calls and return appropriate fixed responses
    const bodyStr = init?.body;
    if (typeof bodyStr === "string") {
      try {
        const body = JSON.parse(bodyStr) as Record<string, unknown>;
        const rf = body["response_format"] as Record<string, unknown> | undefined;
        const js = rf?.["json_schema"] as Record<string, unknown> | undefined;
        if (js?.["name"] === "probe_result") {
          return Promise.resolve(makeSseResponse(
            '{"dominantColor":"blue","hasRedRect":true}',
            String(body["model"] ?? "probe-model")
          ));
        }
        // Recovery VLM calls: return "not classified" so no unclassified_count increment
        if (js?.["name"] === "recovery_classification") {
          return Promise.resolve(makeSseResponse('{"classified":false}', "fallback-recovery"));
        }
      } catch {
        // non-JSON body: fall through to queue
      }
    }

    const handler = queue[index];
    index = Math.min(index + 1, queue.length - 1);
    // Fallback: recovery VLM or extra calls → return classified:false so no unclassified exception
    return Promise.resolve(
      handler
        ? handler()
        : makeSseResponse('{"classified":false}', "fallback")
    );
  });
}
