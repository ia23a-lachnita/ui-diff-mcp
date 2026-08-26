import { z } from "zod";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
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
  rawText: z.string().nullish()
});
export type LocateAnythingElement = z.infer<typeof LocateAnythingElementSchema>;

const LaneMetadataSchema = z.object({
  status: z.enum(["complete", "failed", "not_configured", "skipped"]),
  count: z.number().int().nonnegative(),
  detail: z.string().optional(),
  model: z.string().optional(),
  license: z.string().optional(),
  backend: z.string().optional(),
  abiVersion: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  quantization: z.string().optional(),
  modelSha256: z.string().optional(),
  engineCommit: z.string().optional()
});

export const LocateAnythingResponseSchema = z.object({
  model: z.string().min(1),
  image: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  elements: z.array(LocateAnythingElementSchema),
  warnings: z.array(z.string()).default([]),
  metadata: z.object({
    lanes: z.record(z.string(), LaneMetadataSchema).optional()
  }).optional()
});
export interface LocateAnythingRequestSizing {
  maxDimension: number;
  originalWidth: number;
  originalHeight: number;
  sentWidth: number;
  sentHeight: number;
  scale: number;
  resized: boolean;
}
export type LocateAnythingResponse = z.infer<typeof LocateAnythingResponseSchema> & {
  requestSizing?: LocateAnythingRequestSizing;
};

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
  /** Optional debug artifact path for the exact image bytes sent to the sidecar. */
  debugImagePath?: string;
}

interface JsonPostResponse {
  ok: boolean;
  status: number;
  bodyText: string;
  json(): unknown;
}

function mimeTypeForImagePath(imagePath: string): LocateAnythingRequest["imageMimeType"] | undefined {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

async function withImagePayload(
  request: LocateAnythingRequest,
  maxDimension?: number,
  debugImagePath?: string
): Promise<{ request: LocateAnythingRequest; sizing?: LocateAnythingRequestSizing }> {
  if (request.imageBase64) return { request };

  const imageMimeType = mimeTypeForImagePath(request.imagePath);
  if (!imageMimeType) return { request };

  try {
    const metadata = await sharp(request.imagePath).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;
    let pipeline = sharp(request.imagePath);
    if (maxDimension) {
      pipeline = pipeline.resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true });
    }
    const { data: imageBytes, info } = await pipeline.png().toBuffer({ resolveWithObject: true });
    if (debugImagePath) {
      await fs.mkdir(path.dirname(debugImagePath), { recursive: true });
      await fs.writeFile(debugImagePath, imageBytes);
    }
    const scale = originalWidth && originalHeight
      ? Math.min(info.width / originalWidth, info.height / originalHeight)
      : 1;
    const sizing = maxDimension && originalWidth && originalHeight
      ? {
        maxDimension,
        originalWidth,
        originalHeight,
        sentWidth: info.width,
        sentHeight: info.height,
        scale,
        resized: info.width !== originalWidth || info.height !== originalHeight
      }
      : undefined;
    return {
      request: {
        ...request,
        imageBase64: imageBytes.toString("base64"),
        imageMimeType: "image/png"
      },
      ...(sizing !== undefined ? { sizing } : {})
    };
  } catch {
    // Fall back to raw file read if sharp fails
    try {
      const imageBytes = await fs.readFile(request.imagePath);
      if (debugImagePath) {
        await fs.mkdir(path.dirname(debugImagePath), { recursive: true });
        await fs.writeFile(debugImagePath, imageBytes);
      }
      return { request: { ...request, imageBase64: imageBytes.toString("base64"), imageMimeType } };
    } catch {
      return { request };
    }
  }
}

export async function checkSidecarHealth(endpoint: string, timeoutMs = 5000): Promise<{ ready: boolean; error?: string }> {
  try {
    const resp = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return { ready: false, error: `HTTP ${resp.status}` };
    const body = await resp.json() as { ready?: boolean; error?: string | null };
    const errorMsg = body.error ?? undefined;
    return { ready: body.ready === true, ...(errorMsg !== undefined ? { error: errorMsg } : {}) };
  } catch (err) {
    return { ready: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function postJsonWithTimeout(endpoint: string, pathname: string, body: unknown, timeoutMs: number): Promise<JsonPostResponse> {
  const url = new URL(pathname, endpoint);
  const bodyText = JSON.stringify(body);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyText)
      }
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const responseText = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          bodyText: responseText,
          json() {
            return JSON.parse(responseText);
          }
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end(bodyText);
  });
}

export async function locateUiElements(options: LocateClientOptions): Promise<LocateAnythingResponse> {
  const { endpoint, request, timeoutMs, maxDimension, debugImagePath } = options;

  // Preflight bounded by the caller's own timeoutMs, so a slow/unavailable broker fails
  // within the caller's budget instead of waiting on a fixed internal timeout.
  const health = await checkSidecarHealth(endpoint, timeoutMs);
  if (!health.ready) {
    throw new LocatorUnavailableError(
      health.error ? `Sidecar not ready: ${health.error}` : "Sidecar not ready"
    );
  }

  // Capture original image dimensions before any resize so we can scale coordinates back.
  // The sidecar returns boxes in the coordinate space of the image it received; after a
  // resize the caller still expects boxes in original-image space.
  let originalWidth: number | undefined;
  let originalHeight: number | undefined;
  if (maxDimension && request.imagePath && !request.imageBase64) {
    try {
      const meta = await sharp(request.imagePath).metadata();
      originalWidth = meta.width;
      originalHeight = meta.height;
    } catch { /* ignore — coordinate rescaling won't apply */ }
  }

  const { request: requestBody, sizing: requestSizing } = await withImagePayload(request, maxDimension, debugImagePath);

  let rawResponse: JsonPostResponse;
  try {
    rawResponse = await postJsonWithTimeout(endpoint, "/v1/locate-ui-elements", requestBody, timeoutMs);
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

  const parsed: LocateAnythingResponse = LocateAnythingResponseSchema.parse(json);
  if (requestSizing !== undefined) parsed.requestSizing = requestSizing;

  // Scale box coordinates from resized-image space back to original-image space.
  // The sidecar contract: boxes are in the coordinate space of the image it received.
  // After a resize, parsed.image reflects the smaller sent size, not the original.
  if (
    originalWidth && originalHeight &&
    (originalWidth !== parsed.image.width || originalHeight !== parsed.image.height)
  ) {
    const scaleX = originalWidth / parsed.image.width;
    const scaleY = originalHeight / parsed.image.height;
    for (const el of parsed.elements) {
      el.box.x = Math.round(el.box.x * scaleX);
      el.box.y = Math.round(el.box.y * scaleY);
      el.box.width = Math.round(el.box.width * scaleX);
      el.box.height = Math.round(el.box.height * scaleY);
    }
    parsed.image.width = originalWidth;
    parsed.image.height = originalHeight;
  }

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
