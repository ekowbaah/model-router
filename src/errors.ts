export type GatewayErrorCode = "INVALID_REQUEST" | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "COST_LIMIT_EXCEEDED" | "OUTPUT_VALIDATION_FAILED" | "ALL_PROVIDERS_FAILED" | "STREAMING_UNAVAILABLE";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayError";
  }
}
