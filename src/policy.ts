import {GatewayError} from "./errors.js";

export interface TenantPolicy {
  requestsPerWindow: number;
  windowMs: number;
  dailyBudgetUsd: number;
}

interface WindowState { startedAt: number; requests: number }

export class PolicyStore {
  private readonly policies = new Map<string, TenantPolicy>();
  private readonly windows = new Map<string, WindowState>();
  private readonly spend = new Map<string, {day: string; usd: number}>();

  constructor(private readonly fallback: TenantPolicy = {requestsPerWindow: 60, windowMs: 60_000, dailyBudgetUsd: 10}, private readonly clock = Date.now) {}

  set(tenantId: string, policy: TenantPolicy): void {
    if (policy.requestsPerWindow < 1 || policy.windowMs < 1 || policy.dailyBudgetUsd < 0) throw new GatewayError("INVALID_REQUEST", "tenant policy values are invalid");
    this.policies.set(tenantId, {...policy});
  }

  authorize(tenantId: string, requestedMaxCostUsd: number): void {
    const policy = this.policies.get(tenantId) ?? this.fallback;
    const now = this.clock();
    let window = this.windows.get(tenantId);
    if (!window || now - window.startedAt >= policy.windowMs) {
      window = {startedAt: now, requests: 0};
      this.windows.set(tenantId, window);
    }
    if (window.requests >= policy.requestsPerWindow) throw new GatewayError("RATE_LIMITED", "tenant request rate exceeded", true);
    window.requests++;
    if (this.currentSpend(tenantId) + requestedMaxCostUsd > policy.dailyBudgetUsd) throw new GatewayError("QUOTA_EXCEEDED", "tenant daily cost budget would be exceeded");
  }

  recordCost(tenantId: string, costUsd: number): void {
    this.spend.set(tenantId, {day: this.day(), usd: this.currentSpend(tenantId) + costUsd});
  }

  spentToday(tenantId: string): number { return this.currentSpend(tenantId); }

  private currentSpend(tenantId: string): number {
    const spend = this.spend.get(tenantId);
    return spend?.day === this.day() ? spend.usd : 0;
  }

  private day(): string { return new Date(this.clock()).toISOString().slice(0, 10); }
}
