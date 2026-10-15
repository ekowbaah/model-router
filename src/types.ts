export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface ModelRequest {
  tenantId: string;
  model: string;
  messages: Message[];
  maxCostUsd: number;
  requestId?: string;
  metadata?: Record<string, string>;
  cache?: "use" | "bypass";
  outputValidator?: (value: unknown) => boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  text: string;
  provider: string;
  model: string;
  costUsd: number;
  usage: Usage;
  requestId: string;
  cached?: boolean;
}

export interface StreamChunk {
  delta: string;
  done?: boolean;
  response?: ModelResponse;
}

export interface Provider {
  name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<StreamChunk>;
}

export type AuditOutcome = "success" | "failure" | "cache_hit" | "rate_limited" | "quota_exceeded" | "validation_failed";

export interface AuditEvent {
  requestId: string;
  tenantId: string;
  provider?: string;
  outcome: AuditOutcome;
  attempt: number;
  costUsd: number;
  latencyMs: number;
  at: string;
  errorCode?: string;
  metadata?: Record<string, string>;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void> | void;
}

export interface EvaluationHook {
  evaluate(request: ModelRequest, response: ModelResponse): Promise<void> | void;
}

export interface GatewayMetrics {
  requests: number;
  successes: number;
  failures: number;
  cacheHits: number;
  providerAttempts: Record<string, number>;
  costUsd: number;
}
