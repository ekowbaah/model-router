import {randomUUID} from "node:crypto";
import {SemanticCache} from "./cache.js";
import {GatewayError} from "./errors.js";
import {PolicyStore} from "./policy.js";
import type {AuditEvent, AuditSink, EvaluationHook, GatewayMetrics, ModelRequest, ModelResponse, Provider, StreamChunk} from "./types.js";

export interface RouterOptions {
  attemptsPerProvider: number;
  retryBaseDelayMs: number;
  redactPatterns: RegExp[];
  cache: SemanticCache;
  policies: PolicyStore;
  auditSink?: AuditSink;
  evaluationHooks: EvaluationHook[];
  clock: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  requestId: () => string;
}

const secretPatterns = [/\bsk-[a-zA-Z0-9_-]{12,}\b/g, /\b(?:\d[ -]*?){13,19}\b/g, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi];

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  write(event: AuditEvent): void { this.events.push(structuredClone(event)); }
}

export class ModelRouter {
  private readonly options: RouterOptions;
  readonly metrics: GatewayMetrics = {requests: 0, successes: 0, failures: 0, cacheHits: 0, providerAttempts: {}, costUsd: 0};

  constructor(private readonly providers: Provider[], options: Partial<RouterOptions> = {}) {
    if (providers.length === 0) throw new GatewayError("INVALID_REQUEST", "at least one provider is required");
    this.options = {
      attemptsPerProvider: options.attemptsPerProvider ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 50,
      redactPatterns: options.redactPatterns ?? secretPatterns,
      cache: options.cache ?? new SemanticCache(),
      policies: options.policies ?? new PolicyStore(),
      auditSink: options.auditSink,
      evaluationHooks: options.evaluationHooks ?? [],
      clock: options.clock ?? Date.now,
      sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      requestId: options.requestId ?? randomUUID,
    };
  }

  async complete(input: ModelRequest): Promise<ModelResponse> {
    const request = this.prepare(input);
    const startedAt = this.options.clock();
    this.metrics.requests++;
    try {
      this.options.policies.authorize(request.tenantId, request.maxCostUsd);
    } catch (error) {
      const gatewayError = asGatewayError(error);
      await this.audit(request, undefined, gatewayError.code === "RATE_LIMITED" ? "rate_limited" : "quota_exceeded", 0, 0, startedAt, gatewayError);
      this.metrics.failures++;
      throw gatewayError;
    }

    if (request.cache !== "bypass") {
      const cached = this.options.cache.get(request);
      if (cached) {
        this.metrics.cacheHits++;
        this.metrics.successes++;
        await this.audit(request, cached.provider, "cache_hit", 0, 0, startedAt);
        return {...cached, requestId: request.requestId!};
      }
    }

    const failures: Error[] = [];
    for (const provider of this.providers) {
      for (let attempt = 1; attempt <= this.options.attemptsPerProvider; attempt++) {
        this.metrics.providerAttempts[provider.name] = (this.metrics.providerAttempts[provider.name] ?? 0) + 1;
        try {
          const response = this.validateResponse(request, provider, await provider.complete(request));
          this.options.policies.recordCost(request.tenantId, response.costUsd);
          this.options.cache.set(request, response);
          this.metrics.successes++;
          this.metrics.costUsd += response.costUsd;
          await this.audit(request, provider.name, "success", attempt, response.costUsd, startedAt);
          for (const hook of this.options.evaluationHooks) await hook.evaluate(request, response);
          return response;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          failures.push(failure);
          await this.audit(request, provider.name, failure instanceof GatewayError && failure.code === "OUTPUT_VALIDATION_FAILED" ? "validation_failed" : "failure", attempt, 0, startedAt, failure);
          if (!isRetryable(failure) || attempt === this.options.attemptsPerProvider) break;
          await this.options.sleep(this.options.retryBaseDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    this.metrics.failures++;
    throw new GatewayError("ALL_PROVIDERS_FAILED", "all providers failed", false, {cause: new AggregateError(failures)});
  }

  async *stream(input: ModelRequest): AsyncIterable<StreamChunk> {
    const request = this.prepare({...input, cache: "bypass"});
    this.metrics.requests++;
    this.options.policies.authorize(request.tenantId, request.maxCostUsd);
    const failures: Error[] = [];
    for (const provider of this.providers) {
      if (!provider.stream) continue;
      try {
        let terminal: ModelResponse | undefined;
        for await (const chunk of provider.stream(request)) {
          if (chunk.response) terminal = this.validateResponse(request, provider, chunk.response);
          yield chunk;
        }
        if (!terminal) throw new GatewayError("OUTPUT_VALIDATION_FAILED", "stream ended without a terminal response");
        this.options.policies.recordCost(request.tenantId, terminal.costUsd);
        this.metrics.successes++;
        this.metrics.costUsd += terminal.costUsd;
        return;
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.metrics.failures++;
    const code = failures.length === 0 ? "STREAMING_UNAVAILABLE" : "ALL_PROVIDERS_FAILED";
    throw new GatewayError(code, "no provider completed the stream", false, {cause: new AggregateError(failures)});
  }

  clearTenantCache(tenantId: string): number { return this.options.cache.clearTenant(tenantId); }
  tenantSpend(tenantId: string): number { return this.options.policies.spentToday(tenantId); }

  private prepare(request: ModelRequest): ModelRequest {
    if (!request.tenantId.trim() || !request.model.trim() || request.messages.length === 0 || request.maxCostUsd < 0) {
      throw new GatewayError("INVALID_REQUEST", "tenantId, model, messages, and a non-negative cost limit are required");
    }
    return {...request, requestId: request.requestId ?? this.options.requestId(), messages: request.messages.map((message) => ({...message, content: this.redact(message.content)})), metadata: request.metadata ? {...request.metadata} : undefined};
  }

  private validateResponse(request: ModelRequest, provider: Provider, raw: ModelResponse): ModelResponse {
    if (raw.costUsd < 0 || raw.costUsd > request.maxCostUsd) throw new GatewayError("COST_LIMIT_EXCEEDED", `${provider.name} exceeded the request cost limit`);
    if (request.outputValidator) {
      let value: unknown;
      try { value = JSON.parse(raw.text); } catch { throw new GatewayError("OUTPUT_VALIDATION_FAILED", `${provider.name} returned invalid JSON`); }
      if (!request.outputValidator(value)) throw new GatewayError("OUTPUT_VALIDATION_FAILED", `${provider.name} returned JSON outside the requested schema`);
    }
    return {...raw, provider: provider.name, model: request.model, requestId: request.requestId!};
  }

  private redact(value: string): string { return this.options.redactPatterns.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), value); }

  private async audit(request: ModelRequest, provider: string | undefined, outcome: AuditEvent["outcome"], attempt: number, costUsd: number, startedAt: number, error?: Error): Promise<void> {
    await this.options.auditSink?.write({requestId: request.requestId!, tenantId: request.tenantId, provider, outcome, attempt, costUsd, latencyMs: Math.max(0, this.options.clock() - startedAt), at: new Date(this.options.clock()).toISOString(), errorCode: error instanceof GatewayError ? error.code : error ? "PROVIDER_ERROR" : undefined, metadata: request.metadata});
  }
}

function isRetryable(error: Error): boolean { return !(error instanceof GatewayError) || error.retryable; }
function asGatewayError(error: unknown): GatewayError { return error instanceof GatewayError ? error : new GatewayError("INVALID_REQUEST", String(error)); }
