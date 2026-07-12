import type { ProviderTraceEvent, RuntimeModelUsage, UsageBucket, UsageSummary } from "../schemas/core.js";
import { buildRuntimeModelUsageLedger, type RuntimeModelUsageLedger } from "./provider-trace.js";

function emptyBucket(): UsageBucket {
  return {
    calls: 0,
    successesWithUsage: 0,
    successesMissingUsage: 0,
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
    const hasReportedUsage = hasInputOrOutput || event.totalTokens !== undefined || event.reasoningTokens !== undefined;
    if (hasReportedUsage) bucket.successesWithUsage += 1;
    else bucket.successesMissingUsage += 1;
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
  // Legacy direct callers retain the historical raw-event helper. Pipeline reports
  // use buildUsageSummaryFromLedger() so unmatched lifecycle terminals cannot count.
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

function addRuntimeUsage(bucket: UsageBucket, usage: RuntimeModelUsage): void {
  bucket.errorCalls += usage.callErrorCount;
  bucket.fallbackCalls += usage.fallbackCount;
}

function addMatchedSuccess(bucket: UsageBucket, event: ProviderTraceEvent): void {
  bucket.calls += 1;
  bucket.inputTokens += event.inputTokens ?? 0;
  bucket.outputTokens += event.outputTokens ?? 0;
  bucket.totalTokens += event.totalTokens ?? 0;
  bucket.reasoningTokens += event.reasoningTokens ?? 0;
  bucket.durationMs += event.durationMs ?? 0;

  const hasInputOrOutput = event.inputTokens !== undefined || event.outputTokens !== undefined;
  const hasReportedUsage = hasInputOrOutput || event.totalTokens !== undefined || event.reasoningTokens !== undefined;
  if (hasReportedUsage) bucket.successesWithUsage += 1;
  else bucket.successesMissingUsage += 1;
  if (event.totalTokens !== undefined && !hasInputOrOutput) bucket.totalOnlyUsageCalls += 1;
  else if (!hasReportedUsage) bucket.missingUsageCalls += 1;
}

export function buildUsageSummaryFromLedger(ledger: RuntimeModelUsageLedger): UsageSummary {
  const summary: UsageSummary = {
    ...emptyBucket(),
    byPhase: {},
    byRole: {},
    byRoute: {}
  };

  for (const usage of ledger.usage) {
    addRuntimeUsage(summary, usage);
    addRuntimeUsage(bucketFor(summary.byPhase, usage.phase), usage);
    addRuntimeUsage(bucketFor(summary.byRole, usage.role), usage);
    addRuntimeUsage(bucketFor(summary.byRoute, `${usage.provider}/${usage.model}`), usage);
  }
  for (const event of ledger.matchedSuccesses) {
    addMatchedSuccess(summary, event);
    addMatchedSuccess(bucketFor(summary.byPhase, event.phase), event);
    addMatchedSuccess(bucketFor(summary.byRole, event.role), event);
    addMatchedSuccess(bucketFor(summary.byRoute, `${event.provider}/${event.model}`), event);
  }
  for (const event of ledger.routeExhaustedEvents) {
    summary.routeExhaustedCount += 1;
    bucketFor(summary.byPhase, event.phase).routeExhaustedCount += 1;
    bucketFor(summary.byRole, event.role).routeExhaustedCount += 1;
    bucketFor(summary.byRoute, `${event.provider}/${event.model}`).routeExhaustedCount += 1;
  }
  return summary;
}
