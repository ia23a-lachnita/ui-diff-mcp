import { z } from "zod";

export const LocateAnythingRequestSchema = z.object({
  imagePath: z.string().min(1),
  queries: z.array(z.object({
    id: z.string().min(1),
    prompt: z.string().min(1)
  })).min(1),
  generationMode: z.enum(["detection", "grounding", "hybrid"]).default("hybrid"),
  maxBoxesPerQuery: z.number().int().positive().max(500).default(200)
});
export type LocateAnythingRequest = z.infer<typeof LocateAnythingRequestSchema>;

export const LocateAnythingElementSchema = z.object({
  queryId: z.string().min(1),
  label: z.string().min(1),
  box: z.object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
  }),
  rawBox1000: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite()
  }),
  confidence: z.number().finite().min(0).max(1),
  rawText: z.string().optional()
});
export type LocateAnythingElement = z.infer<typeof LocateAnythingElementSchema>;

export const LocateAnythingResponseSchema = z.object({
  model: z.string().min(1),
  image: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  elements: z.array(LocateAnythingElementSchema),
  warnings: z.array(z.string()).default([])
});
export type LocateAnythingResponse = z.infer<typeof LocateAnythingResponseSchema>;

export class LocatorUnavailableError extends Error {
  readonly code = "locator_unavailable" as const;
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "LocatorUnavailableError";
  }
}

export interface LocateClientOptions {
  endpoint: string;
  request: LocateAnythingRequest;
  timeoutMs: number;
}

export async function locateUiElements(options: LocateClientOptions): Promise<LocateAnythingResponse> {
  const { endpoint, request, timeoutMs } = options;

  let rawResponse: Response;
  try {
    rawResponse = await fetch(`${endpoint}/v1/locate-ui-elements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new LocatorUnavailableError(
      `Sidecar request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!rawResponse.ok) {
    throw new LocatorUnavailableError(
      `Sidecar returned HTTP ${rawResponse.status}`,
      rawResponse.status
    );
  }

  let json: unknown;
  try {
    json = await rawResponse.json();
  } catch {
    throw new LocatorUnavailableError("Sidecar response is not valid JSON");
  }

  const parsed = LocateAnythingResponseSchema.parse(json);

  const { width, height } = parsed.image;
  for (const el of parsed.elements) {
    if (
      el.box.x + el.box.width > width ||
      el.box.y + el.box.height > height
    ) {
      throw new Error(
        `Sidecar returned box out of image bounds: label="${el.label}" ` +
        `box={x:${el.box.x},y:${el.box.y},w:${el.box.width},h:${el.box.height}} ` +
        `image=${width}x${height}`
      );
    }
  }

  return parsed;
}
