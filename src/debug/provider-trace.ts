import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderTraceEvent, UiArtifact } from "../schemas/core.js";
import { ProviderTraceEventSchema } from "../schemas/core.js";

// Explicitly excluded from all events: prompt text, image data URLs/base64,
// raw provider response bodies, API keys, and local crop payloads.
// Only metadata fields defined in ProviderTraceEventSchema are accepted.

export type ProviderTraceSink = (event: Omit<ProviderTraceEvent, "eventId">) => void;

export class ProviderTraceWriter {
  private events: ProviderTraceEvent[] = [];

  emit(event: Omit<ProviderTraceEvent, "eventId">): void {
    const validated = ProviderTraceEventSchema.parse({
      eventId: crypto.randomUUID(),
      ...event
    });
    this.events.push(validated);
  }

  get sink(): ProviderTraceSink {
    return (event) => this.emit(event);
  }

  getEvents(): readonly ProviderTraceEvent[] {
    return this.events;
  }
}

export async function writeProviderTrace(
  artifactDir: string,
  writer: ProviderTraceWriter
): Promise<UiArtifact> {
  await fs.mkdir(artifactDir, { recursive: true });
  const tracePath = path.join(artifactDir, "provider-trace.json");
  await fs.writeFile(tracePath, JSON.stringify(writer.getEvents(), null, 2), "utf8");
  return { role: "provider_trace", path: tracePath };
}
