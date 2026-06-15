import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const LocateAnythingRequestSchema = z.object({
  imagePath: z.string().min(1),
  imageBase64: z.string().min(1).optional(),
  imageMimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
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
  rawBox1000: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite()
  ]),
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
  /** Resize image so its longest dimension does not exceed this value before sending. Default: no resize. */
  maxDimension?: number;
}

function mimeTypeForImagePath(imagePath: string): LocateAnythingRequest["imageMimeType"] | undefined {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

async function withImagePayload(request: LocateAnythingRequest, maxDimension?: number): Promise<LocateAnythingRequest> {
  if (request.imageBase64) return request;

  const imageMimeType = mimeTypeForImagePath(request.imagePath);
  if (!imageMimeType) return request;

  try {
    let pipeline = sharp(request.imagePath);
    if (maxDimension) {
      pipeline = pipeline.resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true });
    }
    const imageBytes = await pipeline.png().toBuffer();
    return {
      ...request,
      imageBase64: imageBytes.toString("base64"),
      imageMimeType: "image/png"
    };
  } catch {
    // Fall back to raw file read if sharp fails
    try {
      const imageBytes = await fs.readFile(request.imagePath);
      return { ...request, imageBase64: imageBytes.toString("base64"), imageMimeType };
    } catch {
      return request;
    }
  }
}

export async function locateUiElements(options: LocateClientOptions): Promise<LocateAnythingResponse> {
  const { endpoint, request, timeoutMs, maxDimension } = options;
  const requestBody = await withImagePayload(request, maxDimension);

  let rawResponse: Response;
  try {
    rawResponse = await fetch(`${endpoint}/v1/locate-ui-elements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
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
