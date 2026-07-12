import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderTraceEvent, RuntimeModelUsage, RuntimeModelUsageDiagnostics, UiArtifact } from "../schemas/core.js";
import { ProviderTraceEventSchema } from "../schemas/core.js";

// Explicitly excluded from all events: prompt text, image data URLs/base64,
// raw provider response bodies, API keys, and local crop payloads.
// Only metadata fields defined in ProviderTraceEventSchema are accepted.

export type ProviderTraceSink = (event: Omit<ProviderTraceEvent, "eventId">) => void;

export class ProviderTraceWriter {
  private events: ProviderTraceEvent[] = [];
  private eventIds = new Set<string>();

  private append(event: ProviderTraceEvent): void {
    if (this.eventIds.has(event.eventId)) return;
    this.eventIds.add(event.eventId);
    this.events.push(event);
  }

  emit(event: Omit<ProviderTraceEvent, "eventId">): void {
    const validated = ProviderTraceEventSchema.parse({
      eventId: crypto.randomUUID(),
      ...event
    });
    this.append(validated);
  }

  importEvents(events: readonly ProviderTraceEvent[]): void {
    for (const event of events) {
      this.append(ProviderTraceEventSchema.parse(event));
    }
  }

  get sink(): ProviderTraceSink {
    return (event) => this.emit(event);
  }

  getEvents(): readonly ProviderTraceEvent[] {
    return this.events;
  }
}

export function parseProviderTraceEvents(value: unknown): ProviderTraceEvent[] {
  return ProviderTraceEventSchema.array().parse(value);
}

export interface RuntimeModelUsageLedger {
  usage: RuntimeModelUsage[];
  diagnostics: RuntimeModelUsageDiagnostics;
  matchedSuccesses: ProviderTraceEvent[];
  routeExhaustedEvents: ProviderTraceEvent[];
}

function usageKey(event: Pick<ProviderTraceEvent, "phase" | "role" | "provider" | "model">): string {
  return [event.phase, event.role, event.provider, event.model].join("\u0000");
}

function createUsage(event: ProviderTraceEvent): RuntimeModelUsage {
  return {
    phase: event.phase,
    role: event.role,
    provider: event.provider,
    model: event.model,
    callStartCount: 0,
    callSuccessCount: 0,
    callErrorCount: 0,
    fallbackCount: 0,
    incompleteStartedCallCount: 0,
    successesWithUsage: 0,
    successesMissingUsage: 0
  };
}

function hasReportedUsage(event: ProviderTraceEvent): boolean {
  return event.inputTokens !== undefined
    || event.outputTokens !== undefined
    || event.totalTokens !== undefined
    || event.reasoningTokens !== undefined;
}

function matchesStartRoute(start: ProviderTraceEvent, terminal: ProviderTraceEvent): boolean {
  return start.phase === terminal.phase
    && start.role === terminal.role
    && start.provider === terminal.provider
    && start.model === terminal.model;
}

function hasExpectedTerminalStatus(event: ProviderTraceEvent): boolean {
  return event.event === "call_success" ? event.status === "ok" : event.status === "error";
}

export function buildRuntimeModelUsageLedger(events: readonly ProviderTraceEvent[]): RuntimeModelUsageLedger {
  const usageByRoute = new Map<string, RuntimeModelUsage>();
  const seenEventIds = new Set<string>();
  const openStarts = new Map<string, ProviderTraceEvent>();
  const pendingFallbacks = new Map<string, number>();
  const diagnostics: RuntimeModelUsageDiagnostics = {
    orphanTerminalCount: 0,
    legacyUnmatchedLifecycleEventCount: 0,
    duplicateCallStartCount: 0,
    fallbackWithoutCallStartCount: 0,
    terminalRouteMismatchCount: 0,
    terminalStatusMismatchCount: 0
  };
  const matchedSuccesses: ProviderTraceEvent[] = [];
  const routeExhaustedEvents: ProviderTraceEvent[] = [];

  for (const event of events) {
    if (seenEventIds.has(event.eventId)) continue;
    seenEventIds.add(event.eventId);

    if (event.event === "fallback") {
      const key = usageKey(event);
      const usage = usageByRoute.get(key);
      if (usage !== undefined) usage.fallbackCount += 1;
      else pendingFallbacks.set(key, (pendingFallbacks.get(key) ?? 0) + 1);
      continue;
    }
    if (event.event === "route_exhausted") {
      routeExhaustedEvents.push(event);
      continue;
    }

    if (event.event !== "call_start" && event.event !== "call_success" && event.event !== "call_error") continue;
    if (event.callId === undefined) {
      diagnostics.legacyUnmatchedLifecycleEventCount += 1;
      continue;
    }

    if (event.event === "call_start") {
      if (openStarts.has(event.callId)) {
        diagnostics.duplicateCallStartCount += 1;
        continue;
      }
      openStarts.set(event.callId, event);
      const key = usageKey(event);
      let usage = usageByRoute.get(key);
      if (usage === undefined) {
        usage = createUsage(event);
        usage.fallbackCount = pendingFallbacks.get(key) ?? 0;
        pendingFallbacks.delete(key);
        usageByRoute.set(key, usage);
      }
      usage.callStartCount += 1;
      continue;
    }

    const start = openStarts.get(event.callId);
    if (start === undefined) {
      diagnostics.orphanTerminalCount += 1;
      continue;
    }
    if (!matchesStartRoute(start, event)) {
      diagnostics.terminalRouteMismatchCount += 1;
      continue;
    }
    if (!hasExpectedTerminalStatus(event)) {
      diagnostics.terminalStatusMismatchCount += 1;
      continue;
    }
    openStarts.delete(event.callId);
    const usage = usageByRoute.get(usageKey(start));
    if (usage === undefined) throw new Error(`Missing runtime usage row for call ${event.callId}`);
    if (event.event === "call_error") {
      usage.callErrorCount += 1;
      continue;
    }

    usage.callSuccessCount += 1;
    matchedSuccesses.push(event);
    if (hasReportedUsage(event)) usage.successesWithUsage += 1;
    else usage.successesMissingUsage += 1;
    if (event.inputTokens !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + event.inputTokens;
    if (event.outputTokens !== undefined) usage.outputTokens = (usage.outputTokens ?? 0) + event.outputTokens;
    if (event.totalTokens !== undefined) usage.totalTokens = (usage.totalTokens ?? 0) + event.totalTokens;
  }

  for (const start of openStarts.values()) {
    const usage = usageByRoute.get(usageKey(start));
    if (usage !== undefined) usage.incompleteStartedCallCount += 1;
  }
  for (const count of pendingFallbacks.values()) diagnostics.fallbackWithoutCallStartCount += count;

  return {
    usage: [...usageByRoute.values()].sort((a, b) =>
      a.phase.localeCompare(b.phase)
      || a.role.localeCompare(b.role)
      || a.provider.localeCompare(b.provider)
      || a.model.localeCompare(b.model)
    ),
    diagnostics,
    matchedSuccesses,
    routeExhaustedEvents
  };
}

export function buildRuntimeModelUsage(events: readonly ProviderTraceEvent[]): RuntimeModelUsage[] {
  return buildRuntimeModelUsageLedger(events).usage;
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
