export interface FreeRunBudgetInput {
  modelCount: number;
  pairCount: number;
  criteriaPerPair: number;
  recoveryRegionCount: number;
  reviewerPolicy: "every_diff" | "sample" | "none";
}

export interface FreeRunBudget {
  estimatedCalls: number;
  probeCallsEstimate: number;
  auditCallsEstimate: number;
  reviewCallsEstimate: number;
  recoveryCallsEstimate: number;
}

export interface OpenRouterKeyInfo {
  is_free_tier: boolean;
  limit: number | null;
  limit_remaining: number | null;
  usage: number;
}

export interface QuotaCheckResult {
  available: boolean;
  estimatedCalls: number;
  limitRemaining: number | null;
  isFreeeTier: boolean | null;
  detail: string;
}

const FREE_TIER_DEFAULT_RPD_LOW = 50;
const FREE_TIER_DEFAULT_RPD_HIGH = 1000;
const PAID_THRESHOLD_DOLLARS = 10;

export function estimateFreeRunBudget(input: FreeRunBudgetInput): FreeRunBudget {
  const probeCallsEstimate = input.modelCount;

  const auditCallsEstimate = input.pairCount * input.criteriaPerPair;

  let reviewCallsEstimate = 0;
  if (input.reviewerPolicy === "every_diff") {
    reviewCallsEstimate = input.pairCount * input.criteriaPerPair;
  } else if (input.reviewerPolicy === "sample") {
    reviewCallsEstimate = Math.ceil(input.pairCount * input.criteriaPerPair * 0.25);
  }

  const recoveryCallsEstimate = input.recoveryRegionCount;

  const estimatedCalls =
    probeCallsEstimate + auditCallsEstimate + reviewCallsEstimate + recoveryCallsEstimate;

  return {
    estimatedCalls,
    probeCallsEstimate,
    auditCallsEstimate,
    reviewCallsEstimate,
    recoveryCallsEstimate
  };
}

export async function lookupOpenRouterQuota(
  apiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<OpenRouterKeyInfo | null> {
  if (!apiKey) return null;

  try {
    const resp = await fetchFn("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      data?: {
        is_free_tier?: boolean;
        limit?: number | null;
        limit_remaining?: number | null;
        usage?: number;
      }
    };
    const d = data?.data;
    if (!d) return null;
    return {
      is_free_tier: d.is_free_tier ?? true,
      limit: d.limit ?? null,
      limit_remaining: d.limit_remaining ?? null,
      usage: d.usage ?? 0
    };
  } catch {
    return null;
  }
}

export function checkFreeQuotaSufficiency(
  budget: FreeRunBudget,
  keyInfo: OpenRouterKeyInfo | null
): QuotaCheckResult {
  const estimatedCalls = budget.estimatedCalls;

  // If quota is unknown (no key info or lookup failed), proceed optimistically.
  // We only block with confirmed, API-reported quota.
  if (!keyInfo || keyInfo.limit_remaining === null) {
    return {
      available: true,
      estimatedCalls,
      limitRemaining: null,
      isFreeeTier: keyInfo?.is_free_tier ?? null,
      detail: "Quota unknown — proceeding optimistically."
    };
  }

  const isFree = keyInfo.is_free_tier;
  const remaining = keyInfo.limit_remaining;

  if (estimatedCalls > remaining) {
    return {
      available: false,
      estimatedCalls,
      limitRemaining: remaining,
      isFreeeTier: isFree,
      detail: `Estimated ${estimatedCalls} calls exceeds available quota of ${remaining} remaining requests.`
    };
  }

  return {
    available: true,
    estimatedCalls,
    limitRemaining: remaining,
    isFreeeTier: isFree,
    detail: "Sufficient quota available."
  };
}

// Rate-limiter: track last N call timestamps and enforce ≤18 RPM
export class FreeCallThrottler {
  private readonly maxRpm: number;
  private readonly windowMs = 60_000;
  private callTimestamps: number[] = [];

  constructor(maxRpm = 18) {
    this.maxRpm = maxRpm;
  }

  async throttle(): Promise<void> {
    const now = Date.now();
    // Evict timestamps older than 1 minute
    this.callTimestamps = this.callTimestamps.filter(t => now - t < this.windowMs);

    if (this.callTimestamps.length >= this.maxRpm) {
      const oldest = this.callTimestamps[0];
      if (oldest !== undefined) {
        const waitMs = this.windowMs - (now - oldest) + 50;
        if (waitMs > 0) {
          await new Promise(resolve => setTimeout(resolve, waitMs));
        }
      }
    }
    this.callTimestamps.push(Date.now());
  }

  get pendingCallCount(): number {
    const now = Date.now();
    return this.callTimestamps.filter(t => now - t < this.windowMs).length;
  }
}
