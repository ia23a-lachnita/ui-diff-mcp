import type { ProviderTraceEvent, UsageBucket, UsageSummary } from "../schemas/core.js";

function emptyBucket(): UsageBucket {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    missingUsageCalls: 0,
    totalOnlyUsageCalls: 0,
    errorCalls: 0,
    fallbackCalls: 0,
    routeExhaustedCount: 0,
    durationMs: 0
  };
}

function addToBucket(bucket: UsageBucket, event: ProviderTraceEvent): void {
  if (event.event === "call_success") {
    bucket.calls += 1;
    bucket.inputTokens += event.inputTokens ?? 0;
    bucket.outputTokens += event.outputTokens ?? 0;
    bucket.totalTokens += event.totalTokens ?? 0;
    bucket.reasoningTokens += event.reasoningTokens ?? 0;
    bucket.durationMs += event.durationMs ?? 0;

    const hasInputOrOutput = event.inputTokens !== undefined || event.outputTokens !== undefined;
    if (event.totalTokens !== undefined && !hasInputOrOutput) {
      bucket.totalOnlyUsageCalls += 1;
    } else if (event.totalTokens === undefined && !hasInputOrOutput && event.reasoningTokens === undefined) {
      bucket.missingUsageCalls += 1;
    }
  } else if (event.event === "call_error") {
    bucket.errorCalls += 1;
  } else if (event.event === "fallback") {
    bucket.fallbackCalls += 1;
  } else if (event.event === "route_exhausted") {
    bucket.routeExhaustedCount += 1;
  }
}

function bucketFor(map: Record<string, UsageBucket>, key: string): UsageBucket {
  map[key] ??= emptyBucket();
  return map[key];
}

export function buildUsageSummary(events: readonly ProviderTraceEvent[]): UsageSummary {
  const summary: UsageSummary = {
    ...emptyBucket(),
    byPhase: {},
    byRole: {},
    byRoute: {}
  };

  for (const event of events) {
    addToBucket(summary, event);
    addToBucket(bucketFor(summary.byPhase, event.phase), event);
    addToBucket(bucketFor(summary.byRole, event.role), event);
    addToBucket(bucketFor(summary.byRoute, `${event.provider}/${event.model}`), event);
  }

  return summary;
}
