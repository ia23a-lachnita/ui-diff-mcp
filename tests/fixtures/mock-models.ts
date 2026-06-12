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

export function makeMockFetch(specs: ModelCallSpec[]): ReturnType<typeof vi.fn> {
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
  return vi.fn().mockImplementation(() => {
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
